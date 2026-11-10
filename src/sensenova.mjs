/**
 * SenseNova U1.5 image API backend (OpenAI Images style).
 *
 *   POST https://token.sensenova.cn/v1/images/generations
 *   POST https://token.sensenova.cn/v1/images/edits
 *
 * Synchronous, Bearer auth, one image per call. Text-to-image calls the
 * generations endpoint; reference images switch to edits, where up to five
 * images arrive as HTTP(S) URLs or complete `data:image/...;base64,...` URLs.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'

export class SenseNovaError extends Error {
  constructor(message, code = 'sensenova_error') {
    super(message)
    this.name = 'SenseNovaError'
    this.code = code
  }
}

const DEFAULT_BASE = 'https://token.sensenova.cn/v1'
const DEFAULT_MODEL = 'sensenova-u1.5-lite'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export function mapSize(value) {
  const text = String(value || '').trim()
  if (!text || text.toLowerCase() === 'auto') return 'auto'
  const named = {
    '1:1': '2048x2048',
    '16:9': '2720x1536',
    '9:16': '1536x2720',
    '3:2': '2496x1664',
    '2:3': '1664x2496',
    '2k': '2048x2048',
    '4k': '4096x4096',
  }
  if (named[text.toLowerCase()]) return named[text.toLowerCase()]
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(text)
  if (match) {
    const width = Number(match[1])
    const height = Number(match[2])
    if (width % 32 === 0 && height % 32 === 0 && width >= 512 && height >= 512 && width <= 4096 && height <= 4096) {
      const ratio = Math.max(width / height, height / width)
      if (ratio <= 3) return `${width}x${height}`
    }
  }
  throw new SenseNovaError(`不支持的尺寸 ${JSON.stringify(value)}：用 auto / 2K / 4K / 1:1 / 16:9 / 512–4096 且为 32 倍数的 WxH`, 'invalid_size')
}

function dataUrlFor(path) {
  const ext = extname(path).toLowerCase()
  const mime = MIME[ext]
  if (!mime) throw new SenseNovaError(`参考图格式仅支持 png/jpg/jpeg/webp: ${path}`, 'unsupported_ref')
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

function imageSize(buffer) {
  try {
    if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buffer[offset + 1]
        const length = buffer.readUInt16BE(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
        }
        offset += 2 + length
      }
    }
  } catch {
    /* dimensions are a nicety, not a requirement */
  }
  return { width: 0, height: 0 }
}

async function fetchWithSignal(url, options, timeoutMs, signal, what) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener?.('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) {
      let detail = ''
      try {
        const body = await response.text()
        detail = body.slice(0, 600)
      } catch {}
      throw new SenseNovaError(`${what}失败: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`, 'http_error')
    }
    return response
  } catch (error) {
    if (error instanceof SenseNovaError) throw error
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new SenseNovaError('已取消', 'cancelled')
      throw new SenseNovaError(`${what}超时（${Math.round(timeoutMs / 1000)}s）`, 'timeout')
    }
    throw new SenseNovaError(`${what}失败: ${error?.message || error}`, 'network_error')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abort)
  }
}

/**
 * Generate or edit one image with SenseNova U1.5.
 * Returns { path, width, height, model, bytes, size }.
 */
export async function generateWithSensenova({
  apiKey,
  prompt,
  refs = [],
  size,
  out,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE,
  watermark = false,
  outputFormat = 'png',
  timeoutSec = 180,
  signal,
}) {
  if (!apiKey) throw new SenseNovaError('缺少 SENSENOVA_API_KEY：设置环境变量，或在 api_key 工具里写入凭据中心', 'no_key')
  if (!prompt?.trim()) throw new SenseNovaError('prompt 为空', 'invalid_prompt')
  if (refs.length > 5) throw new SenseNovaError('最多 5 张参考图', 'too_many_refs')
  for (const ref of refs) if (!existsSync(ref)) throw new SenseNovaError(`参考图不存在: ${ref}`, 'missing_ref')
  if (!out) throw new SenseNovaError('缺少输出路径', 'missing_out')

  const edit = refs.length > 0
  const payload = {
    model,
    prompt: prompt.trim(),
    n: 1,
    size: mapSize(size),
    output_format: outputFormat,
    response_format: 'b64_json',
    watermark: Boolean(watermark),
    prompt_extend: true,
    ...(edit ? { images: refs.map((ref) => ({ image_url: dataUrlFor(ref) })) } : {}),
  }
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/images/${edit ? 'edits' : 'generations'}`
  const response = await fetchWithSignal(
    endpoint,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    Math.max(30, Number(timeoutSec) || 180) * 1000,
    signal,
    edit ? 'SenseNova 图片编辑' : 'SenseNova 生图',
  )
  const data = await response.json()
  const first = data?.data?.[0]
  let bytes
  if (first?.b64_json) {
    bytes = Buffer.from(String(first.b64_json), 'base64')
  } else if (first?.url) {
    const image = await fetchWithSignal(first.url, {}, Math.max(30, Number(timeoutSec) || 180) * 1000, signal, '下载 SenseNova 图片')
    bytes = Buffer.from(await image.arrayBuffer())
  } else {
    throw new SenseNovaError(`SenseNova 响应里没有图片: ${JSON.stringify(data).slice(0, 400)}`, 'empty_image')
  }
  if (bytes.length === 0) throw new SenseNovaError('SenseNova 返回了空图片', 'empty_image')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, bytes)
  const dimensions = imageSize(bytes)
  return {
    path: out,
    width: dimensions.width,
    height: dimensions.height,
    bytes: bytes.length,
    model,
    size: data?.size || payload.size,
  }
}
