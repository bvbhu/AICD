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
 * This module is the plugin entry of the `dsh-shotflow` bundle. It is deliberately
 * NOT mounted at profile level by that bundle: the AI 视频工作流 preset includes it,
 * and any other preset can opt in by adding one row (see README).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { BrowserBridge } from './bridge.mjs'
import { WebError, generateImage, normalizeConversationId, sendPrompt } from './chatgpt.mjs'
import { clearSecret, resolveSecret, secretStatus, setSecret } from './credentials.mjs'
import { startBackgroundJob } from './job-runner.mjs'
import { generateWithSensenova } from './sensenova.mjs'
import { Store, defaultPluginRoot, nowIso, nowStamp, slugify } from './store.mjs'

export const name = 'dsh-shotflow'
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
  channel: {
    type: 'string',
    enum: ['browser', 'sensenova'],
    description:
      '生图渠道，必须由模型按场景选择。browser: ChatGPT 网页版（无需 API key，用网页额度；支持参考图/编辑；分钟级、依赖 Chrome 登录，可能被 Cloudflare 拦截；输出 PNG）。' +
      'sensenova: SenseNova U1.5 图像 API（需 SENSENOVA_API_KEY，按张消耗积分；同步数秒级；支持 1-5 张参考图编辑；512-4096/2K/4K；输出 png/jpeg/webp；无 ChatGPT 对话上下文；稳定、可后台）。',
  },
  ref: strList('参考图路径（可多个，绝对路径；browser 最多按网页限制，sensenova 最多 5 张）'),
  out: str('输出图片路径；默认 <root>/images/<时间>-<摘要>.<format>'),
  size: str('尺寸/比例：browser 写进 prompt 作提示；sensenova 支持 512-4096 且 32 倍数的 WxH、2K/4K、1:1/16:9/9:16/3:2/2:3'),
  format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'sensenova 输出格式；browser 固定 PNG' },
  watermark: bool('sensenova 是否加水印（默认 false；browser 忽略）'),
  model: str('sensenova 模型：sensenova-u1.5-lite（默认）或 sensenova-u1.5-fast'),
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
    reuseExistingTab: config.reuseExistingTab !== false,
    sensenovaBaseUrl: config.sensenovaBaseUrl || 'https://token.sensenova.cn/v1',
    sensenovaModel: config.sensenovaModel || 'sensenova-u1.5-lite',
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

async function runAsk({ store, bridge, defaultTimeout, prepared, signal, progress, reuseExistingTab }) {
  const result = await sendPrompt({
    bridge,
    prompt: prepared.fullPrompt,
    conversation: prepared.conversation,
    timeoutSec: prepared.timeoutSec || defaultTimeout,
    signal,
    onProgress: progress,
    reuseExistingTab,
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

function prepareImage(runtime, args) {
  let prompt = String(args.prompt || '')
  if (!prompt.trim()) throw new Error('prompt 为空')
  const channel = args.channel === 'sensenova' ? 'sensenova' : 'browser'
  if (channel === 'browser' && args.size) prompt = `${prompt.trim()}\n\n（尺寸/比例：${args.size}）`
  const refs = (args.ref || []).map((file) => {
    const path = resolve(file)
    if (!existsSync(path)) throw new Error(`参考图不存在: ${path}`)
    return path
  })
  const format = args.format || 'png'
  const ext = format === 'jpeg' ? 'jpg' : format
  return {
    channel,
    prompt: prompt.trim(),
    out: args.out ? resolve(args.out) : join(runtime.store.images, `${nowStamp()}-${slugify(prompt)}.${channel === 'browser' ? 'png' : ext}`),
    refs,
    size: args.size,
    format,
    watermark: args.watermark === true,
    model: args.model || runtime.sensenovaModel,
    baseUrl: runtime.sensenovaBaseUrl,
    timeoutSec: Number(args.timeout || 0) || undefined,
  }
}

async function runImage({ bridge, defaultTimeout, prepared, signal, progress, reuseExistingTab }) {
  const result = await generateImage({
    bridge,
    prompt: prepared.prompt,
    refs: prepared.refs,
    timeoutSec: prepared.timeoutSec || defaultTimeout,
    signal,
    onProgress: progress,
    out: prepared.out,
    reuseExistingTab,
  })
  return {
    status: 'completed',
    channel: 'browser',
    path: result.path,
    created: nowIso(),
    conversation_id: result.conversation_id,
    width: result.width,
    height: result.height,
  }
}

async function runSensenova({ ctx, prepared, signal, progress }) {
  const secret = await resolveSecret(ctx, 'sensenova')
  if (!secret.value) {
    throw new Error('缺少 SENSENOVA_API_KEY：先设置环境变量（优先），或在 api_key 工具里写入 DSH 凭据中心')
  }
  progress?.('调用 SenseNova 图像接口…')
  const result = await generateWithSensenova({
    apiKey: secret.value,
    prompt: prepared.prompt,
    refs: prepared.refs,
    size: prepared.size,
    out: prepared.out,
    model: prepared.model,
    baseUrl: prepared.baseUrl,
    watermark: prepared.watermark,
    outputFormat: prepared.format,
    timeoutSec: prepared.timeoutSec || 180,
    signal,
  })
  return {
    status: 'completed',
    channel: 'sensenova',
    path: result.path,
    created: nowIso(),
    width: result.width,
    height: result.height,
    model: result.model,
    bytes: result.bytes,
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
  // One browser action at a time: reused tabs and the bridge are serial.
  let lock = Promise.resolve()
  const exclusive = (task) => {
    const run = lock.then(task, task)
    lock = run.catch(() => {})
    return run
  }

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
        return await exclusive(() => runAsk({ store, bridge, defaultTimeout, prepared, reuseExistingTab: runtime.reuseExistingTab }))
      }
      const jobId = startBackgroundJob({
        ctx,
        exec,
        kind: 'gpt',
        label: prepared.prompt,
        task: ({ signal, progress }) => exclusive(() => runAsk({ store, bridge, defaultTimeout, prepared, signal, progress, reuseExistingTab: runtime.reuseExistingTab })),
        formatResult: formatAskJob,
      })
      return { status: 'running', job_id: jobId, conversation_id: '', text: '' }
    },
  })

  ctx.tools.register({
    name: 'gpt_image',
    description:
      '生成或编辑图片。必须由模型指定 channel：' +
      'browser = ChatGPT 网页版（走已登录 Chrome，不消耗 API 额度；支持参考图/编辑；分钟级，依赖浏览器登录，可能被 Cloudflare 拦截；输出 PNG）。' +
      'sensenova = SenseNova U1.5 图像 API（需要 SENSENOVA_API_KEY，按张消耗积分；同步数秒级；支持 1-5 张参考图编辑；尺寸 512-4096/2K/4K；输出 png/jpeg/webp；没有 ChatGPT 对话上下文；稳定、可后台）。' +
      '两个渠道都支持 background=true 立即返回 job_id。',
    parameters: {
      type: 'object',
      properties: IMAGE_PARAMS,
      required: ['prompt', 'channel'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          channel: { type: 'string' },
          path: { type: 'string' },
          created: { type: 'string' },
          conversation_id: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          model: { type: 'string' },
          bytes: { type: 'number' },
          job_id: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.status === 'running' && value.job_id) return imageRunningRender(value.job_id)
        return [{ type: 'text', text: `图片已生成 (${value.channel || 'browser'}): ${value.path || ''}` }]
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `GPT image ${String(args?.prompt || '').slice(0, 60)}`, kind: 'other' }),
    async execute(args, exec) {
      const { store, bridge, defaultTimeout } = createRuntime(config)
      const prepared = prepareImage(runtime, args)
      const isBrowser = prepared.channel === 'browser'
      if (!args.background) {
        if (isBrowser) return await exclusive(() => runImage({ bridge, defaultTimeout, prepared, reuseExistingTab: runtime.reuseExistingTab }))
        return await runSensenova({ ctx, prepared })
      }
      const jobId = startBackgroundJob({
        ctx,
        exec,
        kind: 'gpt-image',
        label: prepared.prompt,
        task: ({ signal, progress }) => isBrowser
          ? exclusive(() => runImage({ bridge, defaultTimeout, prepared, signal, progress, reuseExistingTab: runtime.reuseExistingTab }))
          : runSensenova({ ctx, prepared, signal, progress }),
        formatResult: formatImageJob,
      })
      return { status: 'running', job_id: jobId }
    },
  })

  ctx.tools.register({
    name: 'api_key',
    description:
      '管理 SenseNova / Pixmax 的 API 密钥。读取顺序与 DSH 模型配置一致：环境变量优先；环境变量存在时拒绝写入凭据中心。' +
      'action=status 只看是否配置与来源（不返回值）；action=set 写 DSH 凭据中心（需 value）；action=clear 删除凭据中心里的值。',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: ['sensenova', 'pixmax'], description: 'sensenova=SENSENOVA_API_KEY，pixmax=PIXMAX_BEARER_TOKEN' },
        action: { type: 'string', enum: ['status', 'set', 'clear'], description: 'status / set / clear' },
        value: { type: 'string', description: 'set 时的密钥值；status/clear 不需要' },
      },
      required: ['service', 'action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          service: { type: 'string' },
          configured: { type: 'boolean' },
          source: { type: 'string' },
          env: { type: 'string' },
          envSet: { type: 'boolean' },
          canStore: { type: 'boolean' },
          message: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['status', 'service'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.message || `${value.service}: configured=${value.configured} source=${value.source} env=${value.env}${value.envSet ? '（环境变量已设置，禁止写入凭据中心）' : ''}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const service = String(args.service || '')
      const action = String(args.action || '')
      if (action === 'status') {
        const status = await secretStatus(ctx, service)
        return { status: 'completed', service, ...status, configured: Boolean(status.configured) }
      }
      if (action === 'set') {
        await setSecret(ctx, service, args.value)
        return { status: 'completed', service, message: `${service} 已写入 DSH 凭据中心` }
      }
      if (action === 'clear') {
        const result = await clearSecret(ctx, service)
        return { status: 'completed', service, message: result.envStillSet ? `${service} 已清除凭据中心值；环境变量仍然优先` : `${service} 已清除` }
      }
      throw new Error(`不支持的 action: ${action}`)
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

  const banner = `[dsh-shotflow] gpt_ask/gpt_image/gpt_last registered (bridge ${runtime.bridge.url}, root ${runtime.root}; background jobs via ctx.jobs)`
  ctx.logger?.info?.(banner)
}
