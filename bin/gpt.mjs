#!/usr/bin/env node
/**
 * gpt — talk to the ChatGPT web page through the DSH Browser Control bridge.
 *
 *   gpt ask   "..."            chat with ChatGPT, save the reply as Markdown
 *   gpt image "..."            generate an image with ChatGPT, save it as PNG
 *   gpt last                   print the last conversation id
 *   gpt doctor                 check the bridge / extension / login prerequisites
 *
 * No API key and no headless browser: it drives the user's logged-in Chrome
 * through the same DSH-Browser-Control extension that DSH's browser_* tools use.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserBridge } from '../src/bridge.mjs'
import { WebError, generateImage, normalizeConversationId, sendPrompt } from '../src/chatgpt.mjs'
import { Store, nowIso, nowStamp, renderMarkdown, slugify } from '../src/store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const DEFAULT_TIMEOUT = 300

const log = (message) => process.stderr.write(`[gpt] ${message}\n`)
const fail = (message, code = 1) => {
  process.stderr.write(`[gpt] 错误: ${message}\n`)
  process.exit(code)
}

function cliRoot() {
  return process.env.DSH_GPT_ROOT || REPO_ROOT
}

function readContext(files) {
  const chunks = []
  for (const file of files || []) {
    const path = resolve(file)
    if (!existsSync(path)) fail(`上下文文件不存在: ${path}`)
    chunks.push(`=== 文件: ${path.split(/[\\/]/).pop()} ===\n${readFileSync(path, 'utf8')}`)
  }
  return chunks.join('\n\n')
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { _: [] }
  const flags = new Set(['plain', 'no-save', 'json', 'print-id'])
  const aliases = { f: 'file', o: 'out', c: 'conversation', i: 'ref' }
  const multi = new Set(['file', 'ref'])
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=')
      if (flags.has(name)) {
        options[name] = true
        continue
      }
      const value = inline !== undefined ? inline : rest[++i]
      if (value === undefined) fail(`参数 --${name} 缺少值`)
      options[name] = value
      continue
    }
    if (token.startsWith('-') && token.length === 2) {
      const name = aliases[token[1]] || token[1]
      const value = rest[++i]
      if (value === undefined) fail(`参数 ${token} 缺少值`)
      if (multi.has(name)) (options[name] ||= []).push(value)
      else options[name] = value
      continue
    }
    options._.push(token)
  }
  return { command, options }
}

async function commandAsk(options) {
  let prompt = options._.join(' ')
  if (prompt === '-') prompt = readFileSync(0, 'utf8')
  if (!prompt.trim()) fail('prompt 为空')
  const context = readContext(options.file)
  const fullPrompt = context ? `${context}\n\n${prompt.trim()}` : prompt.trim()

  const store = new Store(cliRoot())
  const bridge = new BrowserBridge()
  const conversation = options.conversation ? resolveConversation(store, options.conversation) : ''
  const timeout = Number(options.timeout || DEFAULT_TIMEOUT)

  try {
    const result = await sendPrompt({
      bridge,
      prompt: fullPrompt,
      conversation,
      timeoutSec: timeout,
      onProgress: log,
    })
    const meta = {
      created: nowIso(),
      conversation_id: result.conversation_id,
      url: `https://chatgpt.com/c/${result.conversation_id}`,
      title: result.title || '',
      turn: result.turns,
      status: 'completed',
    }
    if (options['no-save']) {
      if (options.json) console.log(JSON.stringify({ ...meta, text: result.text }))
      else if (options['print-id']) console.log(meta.conversation_id)
      else console.log(renderMarkdown(fullPrompt, result.text, meta, options.plain))
      store.remember(meta, '')
      return
    }
    const saved = store.saveConversation({
      prompt: fullPrompt,
      reply: result.text,
      meta,
      plain: options.plain,
      out: options.out,
    })
    store.remember(meta, saved.path)
    log(`已保存 ${result.text.length} 字 → ${saved.path}`)
    log(`conversation_id=${meta.conversation_id}`)
    if (options.json) console.log(JSON.stringify({ ...meta, path: saved.path, text: result.text }))
    else if (options['print-id']) console.log(meta.conversation_id)
    else console.log(saved.path)
  } catch (error) {
    fail(error instanceof WebError || error.name === 'BridgeError' ? error.message : String(error))
  }
}

function resolveConversation(store, value) {
  const text = String(value).trim()
  if (/^(last|last-id|last\.json)$/i.test(text)) {
    const last = store.readLast()
    if (!last?.conversation_id) fail('还没有记录过会话；先跑一次 gpt ask')
    return last.conversation_id
  }
  return normalizeConversationId(text)
}

async function commandImage(options) {
  let prompt = options._.join(' ')
  if (prompt === '-') prompt = readFileSync(0, 'utf8')
  if (!prompt.trim()) fail('prompt 为空')
  if (options.size) prompt = `${prompt.trim()}\n\n（尺寸/比例：${options.size}）`

  const store = new Store(cliRoot()).ensure()
  const bridge = new BrowserBridge()
  const out = options.out
    ? resolve(options.out)
    : join(store.images, `${nowStamp()}-${slugify(prompt)}.png`)

  try {
    const result = await generateImage({
      bridge,
      prompt: prompt.trim(),
      refs: (options.ref || []).map((file) => {
        const path = resolve(file)
        if (!existsSync(path)) fail(`参考图不存在: ${path}`)
        return path
      }),
      timeoutSec: Number(options.timeout || DEFAULT_TIMEOUT),
      onProgress: log,
      out,
    })
    log('图片已生成')
    if (options.json) console.log(JSON.stringify({ status: 'completed', ...result, created: nowIso() }))
    else console.log(result.path)
  } catch (error) {
    fail(error instanceof WebError || error.name === 'BridgeError' ? error.message : String(error))
  }
}

async function commandLast(options) {
  const store = new Store(cliRoot())
  const meta = store.readLast()
  if (!meta) fail('还没有记录过会话；先跑一次 gpt ask')
  if (options.json) console.log(JSON.stringify(meta))
  else {
    console.log(meta.conversation_id)
    log(`url=${meta.url}`)
    log(`md=${meta.path}`)
  }
}

async function commandDoctor() {
  const bridge = new BrowserBridge()
  let ok = true
  try {
    const status = await bridge.status()
    const connected = status.extensionConnected === true
    ok = connected
    console.log(`  [${connected ? 'ok' : 'fail'}]   bridge      ${status.port ? `127.0.0.1:${status.port}` : 'not listening'}`)
    const version = status.hello?.version || '?'
    console.log(`  [${connected ? 'ok' : 'fail'}]   extension   DSH-Browser-Control v${version}`)
    const capabilities = status.hello?.capabilities || []
    const needed = ['tabs.open', 'nav', 'eval', 'input', 'cdp']
    const missing = needed.filter((name) => !capabilities.includes(name))
    console.log(`  [${missing.length ? 'fail' : 'ok'}]   commands    ${missing.length ? `missing: ${missing.join(', ')}` : needed.join(', ')}`)
    if (missing.length) ok = false
  } catch (error) {
    ok = false
    console.log(`  [fail]   bridge      ${error.message}`)
  }
  console.log(`  [info]   bridge url  ${bridge.url}`)
  console.log(`  [info]   workspace   ${new Store(cliRoot()).root}`)
  const last = new Store(cliRoot()).readLast()
  if (last) console.log(`  [info]   last conv   ${last.conversation_id}`)
  if (ok) console.log('\n  就绪：gpt ask "问题" → Markdown；gpt image "描述" → PNG')
  else console.log('\n  未就绪：确认 @angelky7/dsh-browser-control 已启用、Chrome 装了 DSH-Browser-Control 扩展并登录 chatgpt.com。')
  process.exit(ok ? 0 : 1)
}

async function main() {
  for (const stream of [process.stdout, process.stderr]) {
    try {
      stream.reconfigure?.({ encoding: 'utf8' })
    } catch {}
  }
  const { command, options } = parseArgs(process.argv.slice(2))
  switch (command) {
    case 'ask':
      return await commandAsk(options)
    case 'image':
      return await commandImage(options)
    case 'last':
      return await commandLast(options)
    case 'doctor':
      return await commandDoctor()
    default:
      console.log(`gpt — ChatGPT 网页版（走 DSH Browser Control 扩展）

用法:
  gpt ask <prompt> [选项]      提问 → Markdown（返回 conversation_id，可续聊）
  gpt image <prompt> [选项]    生图 → PNG
  gpt last [--json]            最近一次会话
  gpt doctor                   检查桥接/扩展

ask 选项:
  -c, --conversation ID        续聊：conversation id、会话 URL 或 last
  -f, --file PATH              附上的上下文文件（可重复）
  -o, --out PATH               Markdown 输出路径
  --plain                      只输出回复正文
  --no-save                    不落盘
  --json                       输出 JSON
  --print-id                   只打印 conversation id
  --timeout SEC                单轮超时（默认 ${DEFAULT_TIMEOUT}）

image 选项:
  -i, --ref PATH               参考图（可重复）
  -o, --out PATH               输出图片路径
  --size 1024x1024|16:9 …      尺寸提示（写在 prompt 末尾）
  --timeout SEC                超时（默认 ${DEFAULT_TIMEOUT}）`)
      process.exit(!command || command === '--help' || command === '-h' ? 0 : 2)
  }
}

main().catch((error) => fail(String(error?.message || error)))
