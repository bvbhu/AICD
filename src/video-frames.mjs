/**
 * Video frame extraction through the DSH Browser Control bridge.
 *
 * No ffmpeg and no native codecs: a tiny loopback HTTP server serves the video
 * file to a hidden Chrome tab, the page seeks an HTMLVideoElement and draws the
 * requested timestamps onto a canvas, and the frames come back as JPEG data
 * URLs. Chrome provides the decoder, which is the same browser the user is
 * already logged into.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.ogv': 'video/ogg',
}

export class VideoError extends Error {
  constructor(message, code = 'video_error') {
    super(message)
    this.name = 'VideoError'
    this.code = code
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function clampTime(value, duration) {
  const max = Math.max(0, duration - 0.04)
  return Math.min(Math.max(0, value), max)
}

/** Parse `12.5`, `"12.5s"`, `"mm:ss"` or `"hh:mm:ss"` into seconds. */
export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  const text = String(value ?? '').trim()
  if (!text) throw new VideoError('时间点为空')
  const numeric = text.replace(/s$/i, '')
  if (/^\d+(\.\d+)?$/.test(numeric)) return Math.max(0, Number(numeric))
  const parts = text.split(':').map((part) => Number(part))
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    throw new VideoError(`无法解析时间点 ${JSON.stringify(value)}（支持 12.5、mm:ss、hh:mm:ss）`)
  }
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return seconds
}

function subsample(list, limit) {
  if (list.length <= limit) return { times: list, truncated: false }
  if (limit <= 1) return { times: [list[0]], truncated: true }
  const picked = []
  for (let i = 0; i < limit; i += 1) {
    const index = Math.round((i * (list.length - 1)) / (limit - 1))
    picked.push(list[index])
  }
  return { times: [...new Set(picked)], truncated: true }
}

/** Build the timestamps to capture from an interval or an explicit list. */
export function planFrameTimes({ duration, every, times, from, to, maxFrames = 12 }) {
  if (!Number.isFinite(duration) || duration <= 0) throw new VideoError('视频时长不可用')
  const limit = Math.max(1, Math.min(16, Math.trunc(Number(maxFrames) || 12)))
  let list
  if (Array.isArray(times) && times.length > 0) {
    list = times.map((value) => clampTime(parseTime(value), duration))
  } else if (every !== undefined && every !== null && String(every).trim() !== '') {
    const step = Number(every)
    if (!Number.isFinite(step) || step <= 0) throw new VideoError('every 必须是大于 0 的秒数')
    const start = clampTime(from === undefined ? 0 : parseTime(from), duration)
    const end = clampTime(to === undefined ? duration : parseTime(to), duration)
    if (end < start) throw new VideoError('to 不能早于 from')
    list = []
    for (let t = start; t <= end + 1e-6; t += step) list.push(clampTime(t, duration))
    if (list.length === 0) list.push(start)
  } else {
    throw new VideoError('需要 every（按间隔）或 times（按时间点）之一')
  }
  list = [...new Set(list)].sort((a, b) => a - b)
  return subsample(list, limit)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function pageHtml(token) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>video probe</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain}</style>
</head><body>
<video id="v" muted playsinline preload="auto" src="/${token}/video"></video>
<script>
const v = document.getElementById('v');
window.__err = '';
window.__meta = false;
v.addEventListener('loadedmetadata', () => { window.__meta = true; });
v.addEventListener('error', () => {
  const e = v.error;
  window.__err = e ? (e.message || ('media error ' + e.code)) : 'video error';
});
window.__videoState = () => ({
  ready: window.__meta === true && v.videoWidth > 0,
  error: window.__err,
  duration: Number.isFinite(v.duration) ? v.duration : 0,
  width: v.videoWidth,
  height: v.videoHeight,
  currentTime: v.currentTime,
  src: v.currentSrc || v.src,
  networkState: v.networkState,
  readyState: v.readyState,
  preload: v.preload
});
setTimeout(() => { try { v.load(); } catch (e) { window.__err = String(e); } }, 500);
function seek(t) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(v.duration)) { reject(new Error('duration unavailable')); return; }
    const target = Math.max(0, Math.min(t, Math.max(0, v.duration - 0.001)));
    if (Math.abs(v.currentTime - target) < 0.001 && v.readyState >= 2) { requestAnimationFrame(() => resolve()); return; }
    const timer = setTimeout(() => { cleanup(); reject(new Error('seek timeout at ' + target.toFixed(3) + 's')); }, 20000);
    const cleanup = () => { clearTimeout(timer); v.removeEventListener('seeked', onSeek); };
    const onSeek = () => { cleanup(); requestAnimationFrame(() => resolve()); };
    v.addEventListener('seeked', onSeek);
    v.currentTime = target;
  });
}
window.__captureAt = async (t, maxWidth, quality) => {
  await seek(t);
  if (v.readyState < 2) throw new Error('frame not decoded yet');
  const scale = Math.min(1, Number(maxWidth) / v.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  return {
    dataUrl: canvas.toDataURL('image/jpeg', Math.min(1, Math.max(0.3, Number(quality) || 0.85))),
    width: canvas.width,
    height: canvas.height,
    time: v.currentTime
  };
};
</script>
</body></html>`
}

function serveVideo(req, res, file, stat, type) {
  const range = req.headers.range
  if (!range) {
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    })
    createReadStream(file).pipe(res)
    return
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
  if (!match) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
    res.end()
    return
  }
  const start = match[1] === '' ? Math.max(0, stat.size - Number(match[2] || 0)) : Number(match[1])
  const end = match[1] === '' ? stat.size - 1 : Math.min(match[2] === '' ? stat.size - 1 : Number(match[2]), stat.size - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
    res.end()
    return
  }
  res.writeHead(206, {
    'content-type': type,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${stat.size}`,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  })
  createReadStream(file, { start, end }).pipe(res)
}

function startServer(file) {
  const stat = statSync(file)
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  const token = randomUUID().replace(/-/g, '')
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const root = `/${token}`
      if (url.pathname === `${root}/`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(pageHtml(token))
        return
      }
      if (url.pathname === `${root}/video`) {
        serveVideo(req, res, file, stat, type)
        return
      }
      res.writeHead(404)
      res.end('not found')
    } catch {
      res.writeHead(500)
      res.end('server error')
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, token, port, url: `http://127.0.0.1:${port}/${token}/` })
    })
  })
}

async function openVideoSession(bridge, file, { keepActive = false } = {}) {
  if (!existsSync(file)) throw new VideoError(`视频文件不存在: ${file}`, 'missing_file')
  const { server, url } = await startServer(file)
  let tabId = 0
  let previousActive = 0
  try {
    previousActive = (await bridge.listTabs())?.activeTabId || 0
  } catch {}
  const close = async () => {
    if (previousActive && previousActive !== tabId) {
      await bridge.command('tabs.activate', { tabId: previousActive }).catch(() => {})
    }
    if (tabId) await bridge.closeTab(tabId).catch(() => {})
    await new Promise((resolve) => {
      const done = () => resolve()
      server.close(done)
      server.closeAllConnections?.()
      setTimeout(done, 3000)
    })
  }
  try {
    // Chrome defers media loading for hidden tabs; make the probe tab active
    // until metadata arrives, then hand focus back to the user's tab.
    tabId = await bridge.openTab(url, {
      active: true,
      waitUntil: 'domcontentloaded',
      timeoutMs: 30000,
    })
    const deadline = Date.now() + 45000
    let state = null
    while (Date.now() < deadline) {
      state = await bridge
        .evalIn(tabId, `window.__videoState ? window.__videoState() : null`, { timeoutMs: 15000 })
        .catch(() => null)
      if (state?.ready) {
        // Keep timers/rAF/media seeking alive even when the Chrome window is not
        // the foreground app. (Frozen background tabs stall `seeked` entirely.)
        await bridge.cdp(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
        await bridge.cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
        if (!keepActive && previousActive && previousActive !== tabId) {
          await bridge.command('tabs.activate', { tabId: previousActive }).catch(() => {})
        }
        return { tabId, url, state, close, previousActive }
      }
      if (state?.error) throw new VideoError(`Chrome 无法解码该视频：${state.error}`, 'decode_failed')
      await sleep(500)
    }
    throw new VideoError('视频加载超时（元数据/首帧未就绪）', 'load_timeout')
  } catch (error) {
    await close()
    throw error
  }
}

/** Read duration/resolution by loading the file in a hidden Chrome tab. */
export async function probeVideo({ bridge, file }) {
  const session = await openVideoSession(bridge, String(file))
  try {
    return {
      path: String(file),
      duration: session.state.duration,
      width: session.state.width,
      height: session.state.height,
    }
  } finally {
    await session.close()
  }
}

/**
 * Extract frames at `every` seconds or at explicit `times`, save them as JPEG,
 * and return their metadata plus the captured bytes (for model attachments).
 */
export async function extractFrames({ bridge, file, every, times, from, to, maxFrames = 12, maxWidth = 1280, quality = 0.85, outDir, onProgress }) {
  // Chrome freezes/suspends background tabs, which stalls `seeked` and canvas
  // capture. Keep the probe tab active until every frame is captured, then
  // restore the user's tab when the session closes.
  const session = await openVideoSession(bridge, String(file), { keepActive: true })
  try {
    const duration = session.state.duration
    const planned = planFrameTimes({ duration, every, times, from, to, maxFrames })
    await mkdir(outDir, { recursive: true })
    const frames = []
    for (let index = 0; index < planned.times.length; index += 1) {
      const at = planned.times[index]
      const captured = await bridge.evalIn(
        session.tabId,
        `window.__captureAt(${Number(at)}, ${Number(maxWidth)}, ${Number(quality)})`,
        { timeoutMs: 60000 },
      )
      if (!captured?.dataUrl?.startsWith('data:image/')) throw new VideoError(`第 ${index + 1} 帧截取失败（${at}s）`, 'capture_failed')
      const base64 = captured.dataUrl.slice(captured.dataUrl.indexOf(',') + 1)
      const bytes = Buffer.from(base64, 'base64')
      const actual = Number(captured.time ?? at)
      const stamp = `${String(Math.floor(actual / 60)).padStart(2, '0')}m${String(Math.round(actual % 60)).padStart(2, '0')}s`
      const path = join(outDir, `frame-${String(index).padStart(3, '0')}-${stamp}.jpg`)
      await writeFile(path, bytes)
      frames.push({ index, time: actual, path, width: captured.width, height: captured.height, bytes: bytes.length, data: bytes })
      onProgress?.(`帧 ${index + 1}/${planned.times.length} @ ${actual.toFixed(2)}s`)
    }
    return {
      path: String(file),
      duration,
      width: session.state.width,
      height: session.state.height,
      frames,
      truncated: planned.truncated,
    }
  } finally {
    await session.close()
  }
}
