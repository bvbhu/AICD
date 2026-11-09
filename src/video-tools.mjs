/**
 * DSH tools for video frame extraction: video_probe / video_frames.
 *
 * `video_frames` cuts frames by interval or explicit timestamps and attaches
 * them to the current conversation as image blocks, so an image-capable
 * conversation model can analyse the video directly. It uses the same DSH
 * Browser Control bridge as the gpt tools and needs no ffmpeg.
 */

import { basename, join, resolve } from 'node:path'

import { BrowserBridge } from './bridge.mjs'
import { Store, defaultPluginRoot, nowStamp, slugify } from './store.mjs'
import { extractFrames, probeVideo } from './video-frames.mjs'

export const name = 'dsh-aicd-video'
export const inject = ['tools']

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const int = (description) => ({ type: 'integer', description })

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

const FRAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['index', 'time', 'path', 'width', 'height', 'bytes'],
  properties: {
    index: { type: 'integer' },
    time: { type: 'number' },
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    image: IMAGE_SCHEMA,
  },
}

function createRuntime(config = {}) {
  const root = config.root || defaultPluginRoot()
  return {
    root,
    store: new Store(root).ensure(),
    bridge: new BrowserBridge({ url: config.bridgeUrl, token: config.token, timeoutMs: 180000 }),
    maxFrames: Number(config.maxFrames || 12),
  }
}

/** Resolve the session's routed model and whether it declares image input. */
async function imageRoute(ctx, exec) {
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    const llm = ctx.get('llm')
    if (!provider || !model || !llm) return { ok: false, reason: '无法解析当前会话的模型路由' }
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    if (!info?.inputModalities?.includes('image')) return { ok: false, reason: `当前模型 ${model} 未声明 image 输入，帧只保存不附加` }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `无法确认模型图像能力：${error?.message || error}` }
  }
}

function formatTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(Math.floor(total % 60)).padStart(2, '0')
  const cs = String(Math.floor((total % 1) * 100)).padStart(2, '0')
  return `${mm}:${ss}.${cs}`
}

function renderSummary(value) {
  const lines = [
    `视频: ${value.path}`,
    `时长: ${Number(value.duration).toFixed(2)}s  分辨率: ${value.width}x${value.height}`,
    `输出目录: ${value.out}`,
    `帧: ${value.frames.length} 张${value.truncated ? '（超过上限，已按时间均匀抽样）' : ''}`,
  ]
  for (const frame of value.frames) {
    lines.push(`  ${formatTime(frame.time)}  ${frame.path}  (${frame.width}x${frame.height}, ${Math.round(frame.bytes / 1024)} KB)`)
  }
  if (value.attached > 0) lines.push(`已附加到会话: ${value.attached} 张（可直接看图分析）`)
  if (value.warning) lines.push(`注意: ${value.warning}`)
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const runtime = createRuntime(config)

  ctx.tools.register({
    name: 'video_probe',
    description: '读取本地视频的时长与分辨率（通过 Chrome 解码，不需要 ffmpeg）。用于决定按什么间隔截帧；截帧本身用 video_frames。',
    parameters: {
      type: 'object',
      properties: {
        path: str('视频文件路径（绝对路径最稳；支持 mp4/mov/webm/mkv 等 Chrome 能解码的格式）'),
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          duration: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['status', 'path', 'duration', 'width', 'height'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `视频: ${value.path}\n时长: ${Number(value.duration).toFixed(2)}s\n分辨率: ${value.width}x${value.height}` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { bridge } = createRuntime(config)
      const file = resolve(String(args.path || ''))
      const info = await probeVideo({ bridge, file })
      return { status: 'completed', ...info }
    },
  })

  ctx.tools.register({
    name: 'video_frames',
    description:
      '按固定间隔（every 秒）或指定时间点（times）从本地视频截帧，保存为 JPEG 并把帧作为图片附加到当前会话，让图像模型直接分析视频内容。' +
      '不需要 ffmpeg；用 Chrome 解码。适合看剧情/分镜/动作/字幕，或按时间抽帧做设定图参考。',
    parameters: {
      type: 'object',
      properties: {
        path: str('视频文件路径（绝对路径最稳）'),
        every: num('按间隔截帧：每隔多少秒一帧（与 times 二选一）'),
        times: {
          type: 'array',
          items: { type: 'string' },
          description: '按指定时间点截帧：秒数或 mm:ss / hh:mm:ss 字符串数组，如 ["3","00:12","1:02:03"]（与 every 二选一）',
        },
        from: str('间隔模式的起始时间（默认 0，支持秒数或 mm:ss）'),
        to: str('间隔模式的结束时间（默认视频结尾）'),
        max_frames: int('最多截多少帧（默认 12，上限 16；超出时按时间均匀抽样）'),
        width: int('输出帧最大宽度像素（默认 1280，保持比例）'),
        quality: num('JPEG 质量 0.3-1（默认 0.85）'),
        out: str('帧输出目录；默认 <root>/video-frames/<视频名>-<时间>/'),
        attach: bool('是否把帧附加到当前会话供模型分析（默认 true）'),
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          duration: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          out: { type: 'string' },
          truncated: { type: 'boolean' },
          attached: { type: 'integer' },
          warning: { type: 'string' },
          frames: { type: 'array', items: FRAME_SCHEMA },
        },
        required: ['status', 'path', 'duration', 'width', 'height', 'out', 'attached', 'frames'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const content = [{ type: 'text', text: renderSummary(value) }]
        for (const frame of value.frames) {
          if (!frame.image) continue
          content.push({
            type: 'image',
            attachment: {
              attachmentId: frame.image.attachmentId,
              mediaType: frame.image.mediaType,
              bytes: frame.image.bytes,
              width: frame.image.width,
              height: frame.image.height,
              ...(frame.image.name ? { name: frame.image.name } : {}),
            },
          })
        }
        return content
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `Video frames ${String(args?.path || '').split(/[\\/]/).pop()}`, kind: 'other' }),
    async execute(args, exec) {
      const { store, bridge, maxFrames } = createRuntime(config)
      const file = resolve(String(args.path || ''))
      if (!args.every && !args.times?.length) throw new Error('需要 every（秒）或 times（时间点数组）之一')
      if (args.every && args.times?.length) throw new Error('every 与 times 只能给一个')
      const outDir = args.out
        ? resolve(String(args.out))
        : join(store.videoFrames, `${slugify(basename(file).replace(/\.[^.]+$/, ''))}-${nowStamp()}`)
      const limit = Math.max(1, Math.min(16, Number(args.max_frames || maxFrames)))
      const result = await extractFrames({
        bridge,
        file,
        every: args.every,
        times: args.times,
        from: args.from,
        to: args.to,
        maxFrames: limit,
        maxWidth: Number(args.width || 1280),
        quality: Number(args.quality || 0.85),
        outDir,
        onProgress: (message) => ctx.logger?.info?.(`[dsh-aicd-video] ${message}`),
      })

      let attached = 0
      let warning = ''
      const attachments = ctx.get('attachments')
      if (args.attach !== false) {
        if (!attachments) {
          warning = '当前上下文没有 attachments 服务，帧只保存到磁盘；可用 read_image 逐张查看'
        } else {
          const route = await imageRoute(ctx, exec)
          if (!route.ok) warning = route.reason
          else {
            for (const frame of result.frames) {
              const ref = await attachments.saveImage({
                data: frame.data,
                mediaType: 'image/jpeg',
                name: basename(frame.path),
              })
              frame.image = {
                attachmentId: ref.attachmentId,
                mediaType: ref.mediaType,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
                ...(ref.name ? { name: ref.name } : {}),
              }
              attached += 1
            }
          }
        }
      }

      return {
        status: 'completed',
        path: result.path,
        duration: result.duration,
        width: result.width,
        height: result.height,
        out: outDir,
        truncated: result.truncated,
        attached,
        ...(warning ? { warning } : {}),
        frames: result.frames.map((frame) => ({
          index: frame.index,
          time: frame.time,
          path: frame.path,
          width: frame.width,
          height: frame.height,
          bytes: frame.bytes,
          ...(frame.image ? { image: frame.image } : {}),
        })),
      }
    },
  })

  ctx.logger?.info?.(`[dsh-aicd-video] video_probe/video_frames registered (output ${runtime.store.videoFrames})`)
}
