/**
 * DSH tools for video analysis: video_probe / video_frames / video_scenes /
 * video_sheet.
 *
 * Primary backend is ffmpeg (configurable path, single-pass fps/select/tile);
 * when no ffmpeg is available, video_probe/video_frames fall back to Chrome
 * decoding through the DSH Browser Control bridge. Frames and contact sheets
 * are attached to the current conversation as image blocks for an
 * image-capable model.
 */

import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { BrowserBridge } from './bridge.mjs'
import { detectScenes, extractFramesWithFfmpeg, makeContactSheet, probeWithFfmpeg, resolveFfmpeg } from './ffmpeg.mjs'
import { Store, defaultPluginRoot, nowStamp, slugify } from './store.mjs'
import { extractFrames as extractChromeFrames, parseTime, probeVideo as probeChromeVideo } from './video-frames.mjs'

export const name = 'dsh-pixmax-workflow-video'
export const inject = ['tools']

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const int = (description) => ({ type: 'integer', description })
const intList = (description) => ({ type: 'array', items: { type: 'integer' }, description })

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
    backend: config.backend || 'auto',
    ffmpeg: resolveFfmpeg(config),
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

function subsample(list, limit) {
  if (list.length <= limit) return list
  const picked = []
  for (let index = 0; index < limit; index += 1) {
    picked.push(list[Math.round((index * (list.length - 1)) / (limit - 1))])
  }
  return [...new Set(picked)]
}

async function attachImages(ctx, exec, frames, { enabled = true } = {}) {
  if (!enabled) return { attached: 0, warning: '' }
  const attachments = ctx.get('attachments')
  if (!attachments) return { attached: 0, warning: '当前上下文没有 attachments 服务，文件只保存到磁盘；可用 read_image 逐张查看' }
  const route = await imageRoute(ctx, exec)
  if (!route.ok) return { attached: 0, warning: route.reason }
  let attached = 0
  for (const frame of frames) {
    const ref = await attachments.saveImage({
      data: readFileSync(frame.path),
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
  return { attached, warning: '' }
}

function renderSummary(value) {
  const lines = [
    `视频: ${value.path}`,
    `时长: ${Number(value.duration).toFixed(2)}s  分辨率: ${value.width}x${value.height}  后端: ${value.backend}`,
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
  // Cordis passes `config: null` for rows whose YAML config is empty.
  config = config || {}
  const runtime = createRuntime(config)

  // ------------------------------------------------------------------ probe
  ctx.tools.register({
    name: 'video_probe',
    description: '读取本地视频的时长、分辨率与帧率。优先用 ffmpeg（ffmpegPath 可配置），没有 ffmpeg 时回退到 Chrome 解码。',
    parameters: {
      type: 'object',
      properties: { path: str('视频文件路径（绝对路径最稳）') },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          duration: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          fps: { type: 'number' },
          codec: { type: 'string' },
          backend: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['status', 'path', 'duration', 'width', 'height', 'backend'],
      },
      render: (_args, value) => [
        { type: 'text', text: `视频: ${value.path}\n时长: ${Number(value.duration).toFixed(2)}s\n分辨率: ${value.width}x${value.height}${value.fps ? `\n帧率: ${value.fps} fps` : ''}\n后端: ${value.backend}` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { bridge, ffmpeg, backend } = createRuntime(config)
      const file = resolve(String(args.path || ''))
      if (backend !== 'chrome' && ffmpeg.error) throw new Error(ffmpeg.error)
      if (backend !== 'chrome' && ffmpeg.ffmpeg) {
        const probe = await probeWithFfmpeg(ffmpeg.ffmpeg, file)
        return { status: 'completed', path: file, ...probe, backend: 'ffmpeg', source: ffmpeg.source }
      }
      const info = await probeChromeVideo({ bridge, file })
      return { status: 'completed', path: file, ...info, backend: 'chrome' }
    },
  })

  // ----------------------------------------------------------------- frames
  ctx.tools.register({
    name: 'video_frames',
    description:
      '从本地视频截帧：按固定间隔（every）、指定时间点（times）或指定帧号（frames），保存 JPEG 并把帧作为图片附加到当前会话。' +
      '默认 ffmpeg 单遍解码；没有 ffmpeg 时回退 Chrome。适合看剧情/分镜/动作/字幕，或做设定图参考。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: str('视频文件路径（绝对路径最稳）'),
        every: num('按间隔截帧：每隔多少秒一帧（与 times / frames 三选一）'),
        times: {
          type: 'array',
          items: { type: 'string' },
          description: '按指定时间点截帧：秒数或 mm:ss / hh:mm:ss 字符串数组，如 ["3","00:12"]（与 every / frames 三选一）',
        },
        frames: intList('按帧号截帧，如 [96, 120]（仅 ffmpeg 后端；与 every / times 三选一）'),
        from: str('间隔模式的起始时间（默认 0，支持秒数或 mm:ss）'),
        to: str('间隔模式的结束时间（默认视频结尾）'),
        max_frames: int('最多截多少帧（默认 12，上限 16；超出时均匀抽样）'),
        width: int('输出帧最大宽度像素（默认 1280，只缩小不放大）'),
        quality: num('JPEG 质量 0.3-1（默认 0.85）'),
        out: str('帧输出目录；默认 <root>/video-frames/<视频名>-<时间>/'),
        attach: bool('是否把帧附加到当前会话（默认 true）'),
        backend: str('auto（默认）| ffmpeg | chrome'),
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          duration: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          out: { type: 'string' },
          backend: { type: 'string' },
          truncated: { type: 'boolean' },
          attached: { type: 'integer' },
          warning: { type: 'string' },
          frames: { type: 'array', items: FRAME_SCHEMA },
        },
        required: ['status', 'path', 'duration', 'width', 'height', 'out', 'backend', 'attached', 'frames'],
      },
      render: (_args, value) => {
        const content = [{ type: 'text', text: renderSummary(value) }]
        for (const frame of value.frames) {
          if (!frame.image) continue
          content.push({ type: 'image', attachment: frame.image })
        }
        return content
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `Video frames ${String(args?.path || '').split(/[\\/]/).pop()}`, kind: 'other' }),
    async execute(args, exec) {
      const { store, bridge, maxFrames, backend: defaultBackend, ffmpeg } = createRuntime(config)
      const file = resolve(String(args.path || ''))
      const modes = [args.every, Array.isArray(args.times) && args.times.length > 0, Array.isArray(args.frames) && args.frames.length > 0].filter(Boolean).length
      if (modes === 0) throw new Error('需要 every（秒）、times（时间点数组）或 frames（帧号数组）之一')
      if (modes > 1) throw new Error('every / times / frames 只能给一个')
      const backend = args.backend || defaultBackend
      if (backend !== 'chrome' && ffmpeg.error) throw new Error(ffmpeg.error)
      const limit = Math.max(1, Math.min(16, Number(args.max_frames || maxFrames)))
      const outDir = args.out
        ? resolve(String(args.out))
        : join(store.videoFrames, `${slugify(basename(file).replace(/\.[^.]+$/, ''))}-${nowStamp()}`)
      const useFfmpeg = backend !== 'chrome' && !!ffmpeg.ffmpeg
      if (!useFfmpeg && Array.isArray(args.frames) && args.frames.length > 0) {
        throw new Error('按帧号截帧需要 ffmpeg；请配置 ffmpegPath 或改用 every/times')
      }
      const from = args.from !== undefined && String(args.from).trim() !== '' ? parseTime(args.from) : undefined
      const to = args.to !== undefined && String(args.to).trim() !== '' ? parseTime(args.to) : undefined

      let result
      if (useFfmpeg) {
        const probe = await probeWithFfmpeg(ffmpeg.ffmpeg, file)
        const times = Array.isArray(args.times) && args.times.length > 0
          ? subsample(args.times.map((value) => parseTime(value)).sort((a, b) => a - b), limit)
          : undefined
        const frameNumbers = Array.isArray(args.frames) && args.frames.length > 0
          ? subsample(args.frames.map((value) => Math.max(0, Math.trunc(Number(value) || 0))).sort((a, b) => a - b), limit)
          : undefined
        result = await extractFramesWithFfmpeg({
          ffmpeg: ffmpeg.ffmpeg,
          file,
          probe,
          every: args.every,
          times,
          frameNumbers,
          from,
          to,
          maxFrames: limit,
          maxWidth: Number(args.width || 1280),
          outDir,
          onProgress: (message) => ctx.logger?.info?.(`[dsh-pixmax-workflow-video] ${message}`),
        })
        result.backend = 'ffmpeg'
        result.duration = probe.duration
        result.width = probe.width
        result.height = probe.height
      } else {
        result = await extractChromeFrames({
          bridge,
          file,
          every: args.every,
          times: args.times,
          from,
          to,
          maxFrames: limit,
          maxWidth: Number(args.width || 1280),
          quality: Number(args.quality || 0.85),
          outDir,
          onProgress: (message) => ctx.logger?.info?.(`[dsh-pixmax-workflow-video] ${message}`),
        })
        result.backend = 'chrome'
      }

      // Attach from disk for both backends: one read, no retained base64.
      const frames = result.frames
      const { attached, warning } = await attachImages(ctx, exec, frames, { enabled: args.attach !== false })

      return {
        status: 'completed',
        path: result.path || file,
        duration: result.duration,
        width: result.width,
        height: result.height,
        out: outDir,
        backend: result.backend,
        truncated: result.truncated,
        attached,
        ...(warning ? { warning } : {}),
        frames: frames.map((frame) => ({
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

  // ----------------------------------------------------------------- scenes
  ctx.tools.register({
    name: 'video_scenes',
    description: '自动寻找镜头切点：用 ffmpeg 的 scene 分数做单遍检测，返回切点时间列表。需要配置 ffmpegPath（或用 PATH 里的 ffmpeg）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: str('视频文件路径'),
        threshold: num('场景变化阈值 0.2–0.5（默认 0.25；画面变化大用低一点）'),
        max_scenes: int('最多返回多少个切点（默认 30）'),
        from: str('检测起始时间（可选，秒数或 mm:ss）'),
        to: str('检测结束时间（可选）'),
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          backend: { type: 'string' },
          count: { type: 'integer' },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['time'],
              properties: {
                time: { type: 'number' },
                display: { type: 'string' },
              },
            },
          },
        },
        required: ['status', 'path', 'backend', 'count', 'scenes'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.scenes.length === 0
            ? `视频: ${value.path}\n没有检测到超过阈值的镜头切点`
            : `视频: ${value.path}\n切点 ${value.count} 个:\n${value.scenes.map((scene) => `  ${scene.display}  (${scene.time}s)`).join('\n')}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { ffmpeg, backend } = createRuntime(config)
      if (backend === 'chrome') throw new Error('video_scenes 只支持 ffmpeg 后端')
      if (ffmpeg.error) throw new Error(ffmpeg.error)
      if (!ffmpeg.ffmpeg) throw new Error('没有可用的 ffmpeg：请配置 ffmpegPath，或把 ffmpeg 放进 PATH')
      const file = resolve(String(args.path || ''))
      const from = args.from !== undefined && String(args.from).trim() !== '' ? parseTime(args.from) : undefined
      const to = args.to !== undefined && String(args.to).trim() !== '' ? parseTime(args.to) : undefined
      const times = await detectScenes({
        ffmpeg: ffmpeg.ffmpeg,
        file,
        threshold: Number(args.threshold || 0.25),
        maxScenes: Math.max(1, Math.min(200, Number(args.max_scenes || 30))),
        from,
        to,
      })
      return {
        status: 'completed',
        path: file,
        backend: 'ffmpeg',
        count: times.length,
        scenes: times.map((time) => ({ time, display: formatTime(time) })),
      }
    },
  })

  // ------------------------------------------------------------------ sheet
  ctx.tools.register({
    name: 'video_sheet',
    description: '把整段视频按固定帧率抽帧并拼成一张总览图（contact sheet），只把这张图附加给模型分析。比逐帧附加省 token。需要 ffmpeg。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: str('视频文件路径'),
        fps: num('采样密度，每秒几张（默认按 cover 自动覆盖整段；显式给出则按此密度取前 CxR 帧）'),
        cover: bool('是否让总览图覆盖整段视频（默认 true；给出 fps 时忽略）'),
        columns: int('拼图列数（默认 4）'),
        rows: int('拼图行数（默认 3）'),
        width: int('每格宽度像素（默认 496）'),
        out: str('输出图片路径；默认 <root>/video-frames/<视频名>-sheet-<时间>.jpg'),
        attach: bool('是否附加到当前会话（默认 true）'),
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          path: { type: 'string' },
          backend: { type: 'string' },
          bytes: { type: 'integer' },
          attached: { type: 'integer' },
          warning: { type: 'string' },
          image: IMAGE_SCHEMA,
        },
        required: ['status', 'path', 'backend', 'bytes', 'attached'],
      },
      render: (_args, value) => {
        const text = `总览图: ${value.path} (${Math.round(value.bytes / 1024)} KB)` +
          (value.attached > 0 ? '\n已附加到会话（一张图看整段）' : '') +
          (value.warning ? `\n注意: ${value.warning}` : '')
        const content = [{ type: 'text', text }]
        if (value.image) content.push({ type: 'image', attachment: value.image })
        return content
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { store, ffmpeg, backend } = createRuntime(config)
      if (backend === 'chrome') throw new Error('video_sheet 只支持 ffmpeg 后端')
      if (ffmpeg.error) throw new Error(ffmpeg.error)
      if (!ffmpeg.ffmpeg) throw new Error('没有可用的 ffmpeg：请配置 ffmpegPath，或把 ffmpeg 放进 PATH')
      const file = resolve(String(args.path || ''))
      const out = args.out
        ? resolve(String(args.out))
        : join(store.videoFrames, `${slugify(basename(file).replace(/\.[^.]+$/, ''))}-sheet-${nowStamp()}.jpg`)
      const columns = Number(args.columns || 4)
      const rows = Number(args.rows || 3)
      let fps = args.fps !== undefined ? Number(args.fps) : undefined
      if (fps === undefined || !Number.isFinite(fps) || fps <= 0) {
        fps = 2
        if (args.cover !== false) {
          try {
            const probe = await probeWithFfmpeg(ffmpeg.ffmpeg, file)
            if (probe.duration > 0) fps = Math.min(30, Math.max(0.01, (columns * rows) / probe.duration))
          } catch {
            /* keep the 2 fps fallback */
          }
        }
      }
      const sheet = await makeContactSheet({
        ffmpeg: ffmpeg.ffmpeg,
        file,
        fps,
        columns,
        rows,
        width: Number(args.width || 496),
        out,
      })
      const frame = { path: out, index: 0, time: 0, width: 0, height: 0, bytes: sheet.bytes }
      const { attached, warning } = await attachImages(ctx, exec, [frame], { enabled: args.attach !== false })
      return {
        status: 'completed',
        path: out,
        backend: 'ffmpeg',
        bytes: sheet.bytes,
        attached,
        ...(warning ? { warning } : {}),
        ...(frame.image ? { image: frame.image } : {}),
      }
    },
  })

  ctx.logger?.info?.(
    `[dsh-pixmax-workflow-video] video_probe/video_frames/video_scenes/video_sheet registered (ffmpeg: ${runtime.ffmpeg.ffmpeg || 'none'}, output ${runtime.store.videoFrames})`,
  )
}
