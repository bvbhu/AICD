/**
 * ffmpeg backend: probe + frame extraction + scene detection + contact sheet.
 *
 * The binary is configurable (`ffmpegPath`) so a portable build (e.g. Format
 * Factory's bundled ffmpeg) works without touching PATH. When no ffmpeg is
 * available the video tools fall back to the Chrome decoder.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class FfmpegError extends Error {
  constructor(message, code = 'ffmpeg_error') {
    super(message)
    this.name = 'FfmpegError'
    this.code = code
  }
}

const COMMON_PATHS = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'D:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\FormatFactory\\ffmpeg.exe',
  'D:\\Program Files\\FormatFactory\\ffmpeg.exe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  join(process.env.ProgramData || '', 'chocolatey', 'bin', 'ffmpeg.exe'),
]

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function findOnPath(name) {
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return ''
}

/**
 * Resolve the ffmpeg binary: explicit config → env → PATH → common installs.
 * `ffprobe` is optional; ffmpeg's `-i` output is parsed when it is absent.
 */
export function resolveFfmpeg(config = {}) {
  const explicit = typeof config.ffmpegPath === 'string' ? config.ffmpegPath.trim() : ''
  if (explicit) {
    if (!isFile(explicit)) return { ffmpeg: '', ffprobe: '', source: '', error: `配置的 ffmpegPath 不存在: ${explicit}` }
    return withProbe(explicit, 'config', config.ffprobePath)
  }
  const envPath = typeof process.env.DSH_FFMPEG_PATH === 'string' ? process.env.DSH_FFMPEG_PATH.trim() : ''
  if (envPath) {
    if (!isFile(envPath)) return { ffmpeg: '', ffprobe: '', source: '', error: `DSH_FFMPEG_PATH 不存在: ${envPath}` }
    return withProbe(envPath, 'env', config.ffprobePath)
  }
  const onPath = findOnPath('ffmpeg.exe') || findOnPath('ffmpeg')
  if (onPath) return withProbe(onPath, 'PATH', config.ffprobePath)
  for (const path of COMMON_PATHS) {
    if (path && isFile(path)) return withProbe(path, 'common', config.ffprobePath)
  }
  return { ffmpeg: '', ffprobe: '', source: '' }
}

function withProbe(ffmpeg, source, configuredProbe) {
  const probe = typeof configuredProbe === 'string' && isFile(configuredProbe) ? configuredProbe : ''
  const sibling = join(dirname(ffmpeg), 'ffprobe.exe')
  return { ffmpeg, ffprobe: probe || (isFile(sibling) ? sibling : ''), source }
}

/** Run ffmpeg and capture stdout/stderr; rejects on a non-zero exit unless allowed. */
export function runFfmpeg(ffmpeg, args, { timeoutMs = 120000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, {
      windowsHide: true,
      cwd: dirname(ffmpeg),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const limit = 4 * 1024 * 1024
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      reject(new FfmpegError(`ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）`, 'ffmpeg_timeout'))
    }, timeoutMs)
    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.removeAllListeners()
      } catch {}
      fn()
    }
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-limit)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-limit)
    })
    child.on('error', (error) => finish(() => reject(new FfmpegError(`无法启动 ffmpeg: ${error.message}`, 'ffmpeg_spawn'))))
    child.on('close', (code) => {
      finish(() => {
        if (code === 0 || allowFail) return resolve({ code, stdout, stderr })
        const tail = stderr.trim().split(/\r?\n/).slice(-12).join('\n')
        reject(new FfmpegError(`ffmpeg 退出码 ${code}\n${tail}`, 'ffmpeg_failed'))
      })
    })
  })
}

/** Parse duration/resolution/fps from `ffmpeg -i` stderr (no ffprobe needed). */
export async function probeWithFfmpeg(ffmpeg, file) {
  if (!isFile(file)) throw new FfmpegError(`视频文件不存在: ${file}`, 'missing_file')
  const { stderr } = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { allowFail: true, timeoutMs: 30000 })
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const videoLine = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Video: ([^\r\n]+)/.exec(stderr)
  if (!videoLine) throw new FfmpegError(`无法从 ffmpeg 输出解析视频流: ${file}`, 'probe_failed')
  const line = videoLine[1]
  const sizeMatch = /(\d{2,5})x(\d{2,5})/.exec(line)
  const fpsMatch = /(\d+(?:\.\d+)?)\s+fps/.exec(line)
  const codec = (line.split(/[,\s]/)[0] || '').replace(/[(),]/g, '')
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0
  if (!sizeMatch) throw new FfmpegError(`无法解析视频分辨率: ${line.slice(0, 160)}`, 'probe_failed')
  return {
    duration,
    width: Number(sizeMatch[1]),
    height: Number(sizeMatch[2]),
    fps: fpsMatch ? Number(fpsMatch[1]) : 0,
    codec,
  }
}

function even(value) {
  const rounded = Math.round(value / 2) * 2
  return Math.max(2, rounded)
}

function scaledSize(probe, maxWidth) {
  const width = maxWidth && probe.width > maxWidth ? Math.trunc(maxWidth) : probe.width
  return { width, height: even((probe.height * width) / probe.width) }
}

function scaleFilter(probe, maxWidth) {
  return maxWidth && probe.width > maxWidth ? `scale=${Math.trunc(maxWidth)}:-2` : ''
}

function stamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(Math.floor(total % 60)).padStart(2, '0')
  return `${mm}m${ss}s`
}

function framePath(outDir, index, time) {
  return join(outDir, `frame-${String(index).padStart(3, '0')}-${stamp(time)}.jpg`)
}

async function collectFrames(outDir, times, probe, maxWidth, prefix) {
  const files = readdirSync(outDir)
    .filter((name) => name.startsWith(prefix) && /\.(jpe?g|png)$/i.test(name))
    .sort()
  const size = scaledSize(probe, maxWidth)
  const frames = []
  for (let index = 0; index < files.length; index += 1) {
    const path = join(outDir, files[index])
    const time = times[index] ?? 0
    const finalPath = framePath(outDir, index, time)
    if (path !== finalPath) {
      await rm(finalPath, { force: true }).catch(() => {})
      await rename(path, finalPath).catch(() => {})
    }
    const target = existsSync(finalPath) ? finalPath : path
    frames.push({
      index,
      time,
      path: target,
      width: size.width,
      height: size.height,
      bytes: statSync(target).size,
    })
  }
  return { frames, size }
}

/** Extract by a fixed interval in one ffmpeg pass (fps filter). */
async function extractInterval({ ffmpeg, file, probe, every, from, to, maxFrames, maxWidth, outDir }) {
  const start = Math.max(0, Math.min(Number(from) || 0, Math.max(0, probe.duration - 0.04)))
  const end = Math.max(start, Math.min(Number(to) || probe.duration, probe.duration))
  const range = Math.max(0.001, end - start)
  let step = Number(every) > 0 ? Number(every) : 1
  let truncated = false
  if (range / step > maxFrames) {
    step = range / maxFrames
    truncated = true
  }
  const filters = [`fps=${(1 / step).toFixed(6)}`]
  const scale = scaleFilter(probe, maxWidth)
  if (scale) filters.push(scale)
  const runId = Math.random().toString(36).slice(2, 9)
  const prefix = `ff-${runId}-`
  const pattern = join(outDir, `${prefix}%03d.jpg`)
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', String(start), '-i', file, '-t', String(range),
    '-vf', filters.join(','),
    '-pix_fmt', 'yuvj420p', '-q:v', '2',
    '-frames:v', String(maxFrames),
    '-y', pattern,
  ]
  await runFfmpeg(ffmpeg, args, { timeoutMs: 180000 })
  const times = Array.from({ length: maxFrames }, (_, index) => start + index * step).filter((time) => time <= end + 0.001)
  const collected = await collectFrames(outDir, times, probe, maxWidth, prefix)
  return { ...collected, truncated }
}

/** Extract at exact timestamps: one precise ffmpeg per timestamp. */
async function extractTimes({ ffmpeg, file, probe, times, maxWidth, outDir, onProgress }) {
  const filters = scaleFilter(probe, maxWidth)
  const frames = []
  const size = scaledSize(probe, maxWidth)
  const runId = Math.random().toString(36).slice(2, 9)
  const prefix = `ff-${runId}-`
  for (let index = 0; index < times.length; index += 1) {
    const time = Math.max(0, Math.min(Number(times[index]) || 0, Math.max(0, probe.duration - 0.04)))
    const path = join(outDir, `${prefix}${String(index).padStart(3, '0')}.jpg`)
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(time), '-i', file, '-frames:v', '1']
    if (filters) args.push('-vf', filters)
    args.push('-pix_fmt', 'yuvj420p', '-q:v', '2', '-y', path)
    await runFfmpeg(ffmpeg, args, { timeoutMs: 60000 })
    onProgress?.(`帧 ${index + 1}/${times.length} @ ${time.toFixed(2)}s`)
    frames.push({ index, time, path, width: size.width, height: size.height, bytes: statSync(path).size })
  }
  const collected = await collectFrames(outDir, frames.map((frame) => frame.time), probe, maxWidth, prefix)
  return { frames: collected.frames, truncated: false, size }
}

/** Extract exact frame numbers with select(n). */
async function extractFrameNumbers({ ffmpeg, file, probe, frameNumbers, maxWidth, outDir }) {
  const selected = [...new Set(frameNumbers.map((value) => Math.max(0, Math.trunc(Number(value) || 0))))].sort((a, b) => a - b)
  if (selected.length === 0) throw new FfmpegError('frames 为空', 'invalid_frames')
  const select = selected.map((value) => `eq(n,${value})`).join('+')
  const parts = [`select='${select}'`, 'setpts=N/TB']
  const scale = scaleFilter(probe, maxWidth)
  if (scale) parts.push(scale)
  const runId = Math.random().toString(36).slice(2, 9)
  const prefix = `ff-${runId}-`
  const pattern = join(outDir, `${prefix}%03d.jpg`)
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file,
    '-vf', parts.join(','), '-fps_mode', 'passthrough',
    '-pix_fmt', 'yuvj420p', '-q:v', '2', '-y', pattern,
  ]
  await runFfmpeg(ffmpeg, args, { timeoutMs: 180000 })
  const times = selected.map((value) => (probe.fps > 0 ? value / probe.fps : 0))
  const collected = await collectFrames(outDir, times, probe, maxWidth, prefix)
  return { ...collected, truncated: false }
}

/**
 * Extract frames with ffmpeg. Modes: `frameNumbers` (exact frames), `times`
 * (exact timestamps), or `every` (single-pass fps filter).
 */
export async function extractFramesWithFfmpeg({
  ffmpeg,
  file,
  probe,
  every,
  times,
  frameNumbers,
  from,
  to,
  maxFrames = 12,
  maxWidth = 1280,
  outDir,
  onProgress,
}) {
  await mkdir(outDir, { recursive: true })
  if (Array.isArray(frameNumbers) && frameNumbers.length > 0) {
    return await extractFrameNumbers({ ffmpeg, file, probe, frameNumbers, maxWidth, outDir })
  }
  if (Array.isArray(times) && times.length > 0) {
    return await extractTimes({ ffmpeg, file, probe, times, maxWidth, outDir, onProgress })
  }
  return await extractInterval({ ffmpeg, file, probe, every, from, to, maxFrames, maxWidth, outDir })
}

/** Detect scene cuts with ffmpeg's scene score + showinfo. */
export async function detectScenes({ ffmpeg, file, threshold = 0.25, maxScenes = 30, from, to }) {
  const start = Math.max(0, Number(from) || 0)
  const args = [
    '-hide_banner', '-nostdin',
    '-ss', String(start), '-i', file,
  ]
  if (Number.isFinite(Number(to)) && Number(to) > start) args.push('-t', String(Number(to) - start))
  args.push('-vf', `select='gt(scene,${Number(threshold)})',showinfo`, '-f', 'null', '-')
  const { stderr } = await runFfmpeg(ffmpeg, args, { timeoutMs: 180000 })
  const times = []
  for (const match of stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
    const value = start + Number(match[1])
    if (value <= start + 0.01) continue
    if (times.length === 0 || Math.abs(value - times[times.length - 1]) > 0.05) times.push(value)
    if (times.length >= maxScenes) break
  }
  return times
}

/** Build a contact sheet (tile) in one pass. */
export async function makeContactSheet({ ffmpeg, file, fps = 2, columns = 4, rows = 3, width = 496, out }) {
  await mkdir(dirname(out), { recursive: true })
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file,
    '-vf', `fps=${Number(fps) || 2},scale=${Math.trunc(width) || 496}:-1,tile=${Math.trunc(columns) || 4}x${Math.trunc(rows) || 3}`,
    '-frames:v', '1', '-q:v', '2', '-pix_fmt', 'yuvj420p', '-y', out,
  ]
  await runFfmpeg(ffmpeg, args, { timeoutMs: 180000 })
  return { path: out, bytes: statSync(out).size }
}

export function ffmpegVersionHint(info) {
  return info?.ffmpeg ? `${info.ffmpeg} (${info.source})` : 'not found'
}
