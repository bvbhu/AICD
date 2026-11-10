/**
 * DSH tools for ChatGPT web: gpt_ask / gpt_image / gpt_last.
 *
 * The tools drive the user's logged-in Chrome through the DSH Browser Control
 * bridge (the same extension used by DSH's browser_* tools), so no API key and
 * no second browser extension are needed.
 *
 * Both long-running tools accept `background: true`: the call starts a DSH
 * background job and returns its id immediately, so the conversation is not
 * blocked while ChatGPT generates. The result is read with `job_output` after
 * the in-session completion notice, and `job_kill` cancels it.
 *
 * This module is the plugin entry of the `dsh-aicd` bundle. It is deliberately
 * NOT mounted at profile level by that bundle: the ai漫剧师 preset includes it,
 * and any other preset can opt in by adding one row (see README).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { BrowserBridge } from './bridge.mjs'
import { WebError, generateImage, normalizeConversationId, sendPrompt } from './chatgpt.mjs'
import { startBackgroundJob } from './job-runner.mjs'
import { Store, defaultPluginRoot, nowIso, nowStamp, slugify } from './store.mjs'

export const name = 'dsh-aicd'
export const inject = ['tools']

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description })

const BACKGROUND_PARAM = bool(
  'true = 立即返回 job_id，在后台生成；期间对话不被阻塞。完成后会收到会话内通知，用 job_output 读取结果，job_kill 取消。默认 false（等待结果再返回）。',
)

const ASK_PARAMS = {
  prompt: str('问题或指令（中文即可）'),
  file: strList('作为上下文附上的文件路径（可多个，绝对路径最稳）'),
  conversation: str('续聊：conversation id、会话 URL，或 last（最近一次会话）'),
  out: str('Markdown 输出路径；默认 <root>/conversations/<时间>-<摘要>.md'),
  timeout: num('单轮超时秒数（默认 300）'),
  background: BACKGROUND_PARAM,
}

const IMAGE_PARAMS = {
  prompt: str('图片描述或编辑指令'),
  ref: strList('参考图路径（可多个，绝对路径）'),
  out: str('输出图片路径；默认 <root>/images/<时间>-<摘要>.png'),
  size: str('尺寸/比例提示：1024x1024、1536x1024、16:9 等（会写进 prompt 末尾）'),
  timeout: num('超时秒数（默认 300）'),
  background: BACKGROUND_PARAM,
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

function resolveConversation(store, value) {
  if (!value) return ''
  const text = String(value).trim()
  if (/^(last|last-id|last\.json)$/i.test(text)) {
    const last = store.readLast()
    if (!last?.conversation_id) throw new Error('还没有记录过会话；先成功调用一次 gpt_ask')
    return last.conversation_id
  }
  return normalizeConversationId(text)
}

function prepareAsk(store, args) {
  const prompt = String(args.prompt || '')
  if (!prompt.trim()) throw new Error('prompt 为空')
  const context = readContext(args.file)
  return {
    prompt: prompt.trim(),
    fullPrompt: context ? `${context}\n\n${prompt.trim()}` : prompt.trim(),
    conversation: resolveConversation(store, args.conversation),
    timeoutSec: Number(args.timeout || 0) || undefined,
  }
}

async function runAsk({ store, bridge, defaultTimeout, prepared, signal, progress }) {
  const result = await sendPrompt({
    bridge,
    prompt: prepared.fullPrompt,
    conversation: prepared.conversation,
    timeoutSec: prepared.timeoutSec || defaultTimeout,
    signal,
    onProgress: progress,
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
    prompt: prepared.fullPrompt,
    reply: result.text,
    meta,
    out: prepared.out,
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
}

function prepareImage(store, args) {
  let prompt = String(args.prompt || '')
  if (!prompt.trim()) throw new Error('prompt 为空')
  if (args.size) prompt = `${prompt.trim()}\n\n（尺寸/比例：${args.size}）`
  const refs = (args.ref || []).map((file) => {
    const path = resolve(file)
    if (!existsSync(path)) throw new Error(`参考图不存在: ${path}`)
    return path
  })
  return {
    prompt: prompt.trim(),
    out: args.out ? resolve(args.out) : join(store.images, `${nowStamp()}-${slugify(prompt)}.png`),
    refs,
    timeoutSec: Number(args.timeout || 0) || undefined,
  }
}

async function runImage({ bridge, defaultTimeout, prepared, signal, progress }) {
  const result = await generateImage({
    bridge,
    prompt: prepared.prompt,
    refs: prepared.refs,
    timeoutSec: prepared.timeoutSec || defaultTimeout,
    signal,
    onProgress: progress,
    out: prepared.out,
  })
  return {
    status: 'completed',
    path: result.path,
    created: nowIso(),
    conversation_id: result.conversation_id,
    width: result.width,
    height: result.height,
  }
}

function formatAskJob(result) {
  const text = String(result.text || '')
  // The job ring keeps ~16 KB after settlement; keep the JSON line well under
  // that so `job_output` still sees the metadata and a useful preview.
  const preview = text.slice(0, 3000)
  return `\n[gpt] 完成\n${JSON.stringify({
    status: 'completed',
    conversation_id: result.conversation_id,
    path: result.path,
    url: result.url,
    title: result.title,
    text: preview,
    text_truncated: text.length > preview.length,
  })}\n`
}

function formatImageJob(result) {
  return `\n[gpt] 完成\n${JSON.stringify({ status: 'completed', ...result })}\n`
}

const askRunningRender = (jobId) => [
  {
    type: 'text',
    text: `已转入后台 job: ${jobId}\n生成期间对话不阻塞；完成后会收到会话内通知。用 job_output 读取结果，job_kill 取消。`,
  },
]

const imageRunningRender = (jobId) => [
  {
    type: 'text',
    text: `图片生成已转入后台 job: ${jobId}\n生成期间对话不阻塞；完成后会收到会话内通知。用 job_output 读取路径，job_kill 取消。`,
  },
]

export function apply(ctx, config = {}) {
  const runtime = createRuntime(config)

  ctx.tools.register({
    name: 'gpt_ask',
    description:
      '向 ChatGPT 网页版提问（走用户已登录的 Chrome + DSH Browser Control 扩展，无 API key），把回复保存为 Markdown，返回文件路径与 conversation_id。' +
      '传 conversation 可续聊已有会话；传 file 可附带上下文文件；传 background=true 可立即返回 job_id，在生成期间继续对话。',
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
          job_id: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.status === 'running' && value.job_id) return askRunningRender(value.job_id)
        return [
          {
            type: 'text',
            text:
              `conversation_id: ${value.conversation_id || ''}\n` +
              (value.path ? `markdown: ${value.path}\n` : '') +
              (value.url ? `url: ${value.url}\n` : '') +
              `\n${value.text || ''}`,
          },
        ]
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `GPT ${String(args?.prompt || '').slice(0, 60)}`, kind: 'other' }),
    async execute(args, exec) {
      const { store, bridge, defaultTimeout } = createRuntime(config)
      const prepared = prepareAsk(store, args)
      prepared.out = args.out ? resolve(args.out) : undefined
      if (!args.background) {
        return await runAsk({ store, bridge, defaultTimeout, prepared })
      }
      const jobId = startBackgroundJob({
        ctx,
        exec,
        kind: 'gpt',
        label: prepared.prompt,
        task: ({ signal, progress }) => runAsk({ store, bridge, defaultTimeout, prepared, signal, progress }),
        formatResult: formatAskJob,
      })
      return { status: 'running', job_id: jobId, conversation_id: '', text: '' }
    },
  })

  ctx.tools.register({
    name: 'gpt_image',
    description:
      '用 ChatGPT 网页版生成图片（走已登录 Chrome + DSH Browser Control 扩展，不消耗 API 额度），支持参考图（图生图/改风格）。返回保存的绝对路径；传 background=true 可立即返回 job_id，在生成期间继续对话。',
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
          job_id: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.status === 'running' && value.job_id) return imageRunningRender(value.job_id)
        return [{ type: 'text', text: `图片已生成: ${value.path || ''}` }]
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `GPT image ${String(args?.prompt || '').slice(0, 60)}`, kind: 'other' }),
    async execute(args, exec) {
      const { store, bridge, defaultTimeout } = createRuntime(config)
      const prepared = prepareImage(store, args)
      if (!args.background) {
        return await runImage({ bridge, defaultTimeout, prepared })
      }
      const jobId = startBackgroundJob({
        ctx,
        exec,
        kind: 'gpt-image',
        label: prepared.prompt,
        task: ({ signal, progress }) => runImage({ bridge, defaultTimeout, prepared, signal, progress }),
        formatResult: formatImageJob,
      })
      return { status: 'running', job_id: jobId }
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

  const banner = `[dsh-aicd] gpt_ask/gpt_image/gpt_last registered (bridge ${runtime.bridge.url}, root ${runtime.root}; background jobs via ctx.jobs)`
  ctx.logger?.info?.(banner)
}
