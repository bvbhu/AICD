/**
 * DSH tools for ChatGPT web: gpt_ask / gpt_image / gpt_last.
 *
 * The tools drive the user's logged-in Chrome through the DSH Browser Control
 * bridge (the same extension used by DSH's browser_* tools), so no API key and
 * no second browser extension are needed.
 *
 * This module is the plugin entry of the `dsh-aicd` bundle. It is deliberately
 * NOT mounted at profile level by that bundle: the ai漫剧师 preset includes it,
 * and any other preset can opt in by adding one row (see README).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { BrowserBridge } from './bridge.mjs'
import { WebError, generateImage, normalizeConversationId, sendPrompt } from './chatgpt.mjs'
import { Store, defaultPluginRoot, nowIso, nowStamp, slugify } from './store.mjs'

export const name = 'dsh-aicd'
export const inject = ['tools']

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description })

const ASK_PARAMS = {
  prompt: str('问题或指令（中文即可）'),
  file: strList('作为上下文附上的文件路径（可多个，绝对路径最稳）'),
  conversation: str('续聊：conversation id、会话 URL，或 last（最近一次会话）'),
  out: str('Markdown 输出路径；默认 <root>/conversations/<时间>-<摘要>.md'),
  timeout: num('单轮超时秒数（默认 300）'),
}

const IMAGE_PARAMS = {
  prompt: str('图片描述或编辑指令'),
  ref: strList('参考图路径（可多个，绝对路径）'),
  out: str('输出图片路径；默认 <root>/images/<时间>-<摘要>.png'),
  size: str('尺寸/比例提示：1024x1024、1536x1024、16:9 等（会写进 prompt 末尾）'),
  timeout: num('超时秒数（默认 300）'),
}

function readContext(files) {
  const chunks = []
  for (const file of files || []) {
    const path = resolve(file)
    if (!existsSync(path)) throw new Error(`上下文文件不存在: ${path}`)
    chunks.push(`=== 文件: ${path.split(/[\\/]/).pop()} ===\n${readFileSync(path, 'utf8')}`)
  }
  return chunks.join('\n\n')
}

function createRuntime(config = {}) {
  const root = config.root || defaultPluginRoot()
  return {
    root,
    store: new Store(root).ensure(),
    bridge: new BrowserBridge({
      url: config.bridgeUrl,
      token: config.token,
      timeoutMs: Number(config.timeoutSec || 300) * 1000,
    }),
    defaultTimeout: Number(config.timeoutSec || 300),
  }
}

export function apply(ctx, config = {}) {
  const runtime = createRuntime(config)

  ctx.tools.register({
    name: 'gpt_ask',
    description:
      '向 ChatGPT 网页版提问（走用户已登录的 Chrome + DSH Browser Control 扩展，无 API key），把回复保存为 Markdown，返回文件路径与 conversation_id。' +
      '传 conversation 可续聊已有会话；传 file 可附带上下文文件。适合让 GPT 网页版做审查、翻译、写作、解释，无需自己操作浏览器。',
    parameters: {
      type: 'object',
      properties: ASK_PARAMS,
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          conversation_id: { type: 'string' },
          text: { type: 'string' },
          path: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['status', 'conversation_id', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `conversation_id: ${value.conversation_id}\n` +
            (value.path ? `markdown: ${value.path}\n` : '') +
            (value.url ? `url: ${value.url}\n` : '') +
            `\n${value.text}`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `GPT ${String(args?.prompt || '').slice(0, 60)}`, kind: 'other' }),
    async execute(args) {
      const { store, bridge, defaultTimeout } = createRuntime(config)
      const prompt = String(args.prompt || '')
      if (!prompt.trim()) throw new Error('prompt 为空')
      const context = readContext(args.file)
      const fullPrompt = context ? `${context}\n\n${prompt.trim()}` : prompt.trim()

      let conversation = ''
      if (args.conversation) {
        const value = String(args.conversation).trim()
        if (/^(last|last-id|last\.json)$/i.test(value)) {
          const last = store.readLast()
          if (!last?.conversation_id) throw new Error('还没有记录过会话；先成功调用一次 gpt_ask')
          conversation = last.conversation_id
        } else {
          conversation = normalizeConversationId(value)
        }
      }

      const result = await sendPrompt({
        bridge,
        prompt: fullPrompt,
        conversation,
        timeoutSec: Number(args.timeout || defaultTimeout),
      })
      const meta = {
        created: nowIso(),
        conversation_id: result.conversation_id,
        url: `https://chatgpt.com/c/${result.conversation_id}`,
        title: result.title || '',
        turn: result.turns,
        status: 'completed',
      }
      const saved = store.saveConversation({
        prompt: fullPrompt,
        reply: result.text,
        meta,
        out: args.out ? resolve(args.out) : undefined,
      })
      store.remember(meta, saved.path)
      return {
        status: 'completed',
        conversation_id: meta.conversation_id,
        text: result.text,
        path: saved.path,
        url: meta.url,
        title: meta.title,
      }
    },
  })

  ctx.tools.register({
    name: 'gpt_image',
    description:
      '用 ChatGPT 网页版生成图片（走已登录 Chrome + DSH Browser Control 扩展，不消耗 API 额度），支持参考图（图生图/改风格）。返回保存的绝对路径。',
    parameters: {
      type: 'object',
      properties: IMAGE_PARAMS,
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          created: { type: 'string' },
          conversation_id: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['status', 'path'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `图片已生成: ${value.path}` }],
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `GPT image ${String(args?.prompt || '').slice(0, 60)}`, kind: 'other' }),
    async execute(args) {
      const { store, bridge, defaultTimeout } = createRuntime(config)
      let prompt = String(args.prompt || '')
      if (!prompt.trim()) throw new Error('prompt 为空')
      if (args.size) prompt = `${prompt.trim()}\n\n（尺寸/比例：${args.size}）`
      const out = args.out ? resolve(args.out) : join(store.images, `${nowStamp()}-${slugify(prompt)}.png`)
      const refs = (args.ref || []).map((file) => {
        const path = resolve(file)
        if (!existsSync(path)) throw new Error(`参考图不存在: ${path}`)
        return path
      })
      const result = await generateImage({
        bridge,
        prompt: prompt.trim(),
        refs,
        timeoutSec: Number(args.timeout || defaultTimeout),
        out,
      })
      return {
        status: 'completed',
        path: result.path,
        created: nowIso(),
        conversation_id: result.conversation_id,
        width: result.width,
        height: result.height,
      }
    },
  })

  ctx.tools.register({
    name: 'gpt_last',
    description: '返回最近一次 gpt_ask 会话的 conversation_id、URL 与 Markdown 路径，用于续聊（gpt_ask 的 conversation 可传 last 或该 id）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          conversation_id: { type: 'string' },
          url: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['status', 'conversation_id'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `conversation_id: ${value.conversation_id}${value.url ? `\nurl: ${value.url}` : ''}${value.path ? `\nmarkdown: ${value.path}` : ''}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const { store } = createRuntime(config)
      const meta = store.readLast()
      if (!meta?.conversation_id) throw new Error('没有可用会话记录；先成功调用一次 gpt_ask')
      return { status: 'completed', conversation_id: String(meta.conversation_id), url: String(meta.url || ''), path: String(meta.path || '') }
    },
  })

  const banner = `[dsh-aicd] gpt_ask/gpt_image/gpt_last registered (bridge ${new BrowserBridge({ url: config.bridgeUrl, token: config.token }).url}, root ${runtime.root})`
  ctx.logger?.info?.(banner)
}
