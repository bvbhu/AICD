/**
 * Image tools: `model_list` and `image_generation`.
 *
 * `image_generation` takes a **model id** chosen by the model itself or the
 * user's default: `browser/gpt-image-2` routes to the ChatGPT web page, any
 * other `provider/modelid` routes to an OpenAI-Images-compatible endpoint
 * configured in the Pixmax Workflow settings page. API keys are never tool arguments:
 * they are read from an environment variable or the DSH credential center, and
 * the settings page is the only place that writes them.
 *
 * `model_list` reports the same registry plus each model's key state (presence
 * and source only, never the value).
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { BrowserBridge } from './bridge.mjs'
import { generateImage } from './chatgpt.mjs'
import { keyStatus, resolveKey } from './credentials.mjs'
import { generateWithProvider } from './image-api.mjs'
import { BROWSER_MODEL_ID, describeModel, effectiveModels, loadImageSettings, resolveImageModel } from './image-models.mjs'
import { startBackgroundJob } from './job-runner.mjs'
import { Store, defaultPluginRoot, nowIso, nowStamp, slugify } from './store.mjs'

export const name = 'dsh-pixmax-workflow-image'
export const inject = ['tools']

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description })

const BACKGROUND_PARAM = bool(
  'true = 立即返回 job_id，在后台生成；期间对话不被阻塞。完成后会收到会话内通知，用 job_output 读取结果，job_kill 取消。默认 false（等待结果再返回）。',
)

const IMAGE_PARAMS = {
  prompt: str('图片描述或编辑指令'),
  model: str(
    '生图模型 id（provider/model）。browser/gpt-image-2 = ChatGPT 网页版（默认；走已登录 Chrome，无 API key，支持参考图/改图，分钟级，可能被 Cloudflare 拦，固定 PNG）；' +
      '其他 openai 兼容端点用 provider/modelid（例如 sensenova/sensenova-u1.5-lite）。不传 = 用设置页里的默认模型。用 model_list 查看可用模型。',
  ),
  ref: strList('参考图路径（可多个，绝对路径；浏览器渠道按网页限制，端点渠道最多 5 张）'),
  out: str('输出图片路径；默认 <root>/images/<时间>-<摘要>.<format>'),
  size: str('尺寸/比例：浏览器渠道写进 prompt 作提示；端点渠道支持 512-4096 且 32 倍数的 WxH、2K/4K、1:1/16:9/9:16/3:2/2:3'),
  format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: '端点渠道输出格式；浏览器渠道固定 PNG' },
  watermark: bool('端点渠道是否加水印（默认 false；浏览器渠道忽略）'),
  timeout: num('超时秒数（默认 300）'),
  background: BACKGROUND_PARAM,
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
  }
}

function prepareImage(runtime, args) {
  const settings = loadImageSettings(runtime.root)
  const { model } = resolveImageModel(settings, args.model)
  let prompt = String(args.prompt || '')
  if (!prompt.trim()) throw new Error('prompt 为空')
  if (model.kind === 'browser' && args.size) prompt = `${prompt.trim()}\n\n（尺寸/比例：${args.size}）`
  const refs = (args.ref || []).map((file) => {
    const path = resolve(file)
    if (!existsSync(path)) throw new Error(`参考图不存在: ${path}`)
    return path
  })
  const format = model.kind === 'browser' ? 'png' : args.format || 'png'
  const ext = format === 'jpeg' ? 'jpg' : format
  return {
    model,
    prompt: prompt.trim(),
    out: args.out ? resolve(args.out) : join(runtime.store.images, `${nowStamp()}-${slugify(prompt)}.${ext}`),
    refs,
    size: args.size,
    format,
    watermark: args.watermark === true,
    timeoutSec: Number(args.timeout || 0) || undefined,
  }
}

async function runBrowserImage({ bridge, defaultTimeout, prepared, signal, progress, reuseExistingTab }) {
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
    model: prepared.model.id,
    channel: 'browser',
    path: result.path,
    created: nowIso(),
    conversation_id: result.conversation_id,
    width: result.width,
    height: result.height,
  }
}

async function runModelImage({ ctx, prepared, signal, progress }) {
  const model = prepared.model
  const key = await resolveKey(ctx, model)
  if (!key.value) {
    const where = key.envKey ? `环境变量 ${key.envKey}` : '环境变量'
    throw new Error(
      `模型 ${model.id} 缺少 API key：在 Settings → 插件 → Pixmax Workflow 里给它填一个（会写入 DSH 凭据中心 ${key.credentialName}），` +
        `或设置${where}（环境变量优先，设置后设置页不再写入）。`,
    )
  }
  progress?.(`调用 ${model.id}…`)
  const sensenovaLike = model.apiStyle === 'json' && model.provider === 'sensenova'
  const result = await generateWithProvider({
    apiKey: key.value,
    prompt: prepared.prompt,
    refs: prepared.refs,
    size: prepared.size,
    out: prepared.out,
    model: model.model,
    baseUrl: model.baseUrl,
    apiStyle: model.apiStyle === 'multipart' ? 'multipart' : 'json',
    providerFields: sensenovaLike,
    outputFormat: prepared.format,
    watermark: prepared.watermark,
    timeoutSec: prepared.timeoutSec || 180,
    signal,
    label: model.label || model.id,
  })
  return {
    status: 'completed',
    model: model.id,
    channel: 'openai',
    path: result.path,
    created: nowIso(),
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    endpoint: result.endpoint,
  }
}

function formatImageJob(result) {
  return `\n[image] 完成\n${JSON.stringify({ status: 'completed', ...result })}\n`
}

const imageRunningRender = (jobId) => [
  {
    type: 'text',
    text: `图片生成已转入后台 job: ${jobId}\n生成期间对话不阻塞；完成后会收到会话内通知。用 job_output 读取路径，job_kill 取消。`,
  },
]

export function apply(ctx, config = {}) {
  const runtime = createRuntime(config)
  // One browser action at a time: the reused ChatGPT tab and the bridge are serial.
  let lock = Promise.resolve()
  const exclusive = (task) => {
    const run = lock.then(task, task)
    lock = run.catch(() => {})
    return run
  }

  ctx.tools.register({
    name: 'image_generation',
    description:
      '图像生成 / Image Generation：生成或编辑图片。用 model 选模型（provider/model）：browser/gpt-image-2 = ChatGPT 网页版（默认；走已登录 Chrome，不消耗 API 额度，支持参考图/改图，分钟级，可能被 Cloudflare 拦，固定 PNG）；' +
      '其他 openai 兼容端点写 provider/modelid（例如 sensenova/sensenova-u1.5-lite，按张计费、秒级、支持 1-5 张参考图、输出 png/jpeg/webp）。' +
      '可用模型与各自是否已配 key 见 model_list；API key 在 Settings → 插件 → Pixmax Workflow 里配置，不是工具参数。支持 background=true。',
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
          model: { type: 'string' },
          channel: { type: 'string' },
          path: { type: 'string' },
          created: { type: 'string' },
          conversation_id: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          bytes: { type: 'number' },
          endpoint: { type: 'string' },
          job_id: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.status === 'running' && value.job_id) return imageRunningRender(value.job_id)
        return [{ type: 'text', text: `图片已生成 (${value.model || value.channel || ''}): ${value.path || ''}` }]
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `Image Generation ${String(args?.prompt || '').slice(0, 60)}`,
      kind: 'other',
    }),
    async execute(args, exec) {
      const { bridge, defaultTimeout } = createRuntime(config)
      const prepared = prepareImage(runtime, args)
      const isBrowser = prepared.model.kind === 'browser'
      if (!args.background) {
        if (isBrowser) {
          return await exclusive(() =>
            runBrowserImage({ bridge, defaultTimeout, prepared, reuseExistingTab: runtime.reuseExistingTab }),
          )
        }
        return await runModelImage({ ctx, prepared })
      }
      const jobId = startBackgroundJob({
        ctx,
        exec,
        kind: 'image',
        label: prepared.prompt,
        task: ({ signal, progress }) =>
          isBrowser
            ? exclusive(() =>
                runBrowserImage({
                  bridge,
                  defaultTimeout,
                  prepared,
                  signal,
                  progress,
                  reuseExistingTab: runtime.reuseExistingTab,
                }),
              )
            : runModelImage({ ctx, prepared, signal, progress }),
        formatResult: formatImageJob,
      })
      return { status: 'running', job_id: jobId }
    },
  })

  ctx.tools.register({
    name: 'model_list',
    description:
      '列出生图模型：每个模型的 id（provider/model）、类型（browser = ChatGPT 网页，openai = OpenAI 兼容端点）、端点地址、' +
      '是否为内置模型、是否已配 API key（只看是否存在与来源，不返回值），以及当前默认模型。' +
      'image_generation 的 model 参数取这里的 id；模型与 key 在 Settings → 插件 → Pixmax Workflow 里增删改。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          default: { type: 'string' },
          count: { type: 'number' },
          models: { type: 'array', items: { type: 'object' } },
        },
        required: ['status', 'default', 'models'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `默认模型: ${value.default}`,
            ...(value.models || []).map((model) => {
              const key = model.key
              const keyText =
                model.kind === 'browser'
                  ? '无需 key'
                  : key?.configured
                    ? `key: ${key.source === 'env' ? '环境变量' : '凭据中心'}`
                    : 'key: 未配置'
              return `- ${model.id}${model.id === value.default ? ' (默认)' : ''} · ${model.label} · ${model.kind} · ${keyText}${model.baseUrl ? ` · ${model.baseUrl}` : ''}`
            }),
          ].join('\n'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const settings = loadImageSettings(runtime.root)
      const models = effectiveModels(settings)
      const described = []
      for (const model of models) {
        described.push(
          describeModel(
            model,
            model.kind === 'browser' ? { configured: true, source: 'browser' } : await keyStatus(ctx, model),
          ),
        )
      }
      return {
        status: 'completed',
        default: settings.defaultModel || BROWSER_MODEL_ID,
        count: described.length,
        models: described,
      }
    },
  })

  ctx.logger?.info?.(
    `[dsh-pixmax-workflow-image] image_generation/model_list registered (bridge ${runtime.bridge.url}, root ${runtime.root}; models: ${effectiveModels(loadImageSettings(runtime.root)).map((model) => model.id).join(', ')})`,
  )
}
