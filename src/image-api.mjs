/**
 * OpenAI-Images-style image backend used by every non-browser model.
 *
 * Two request shapes are supported, selected per model:
 *
 *   apiStyle: 'json'      — POST {baseUrl}/images/{generations|edits} with a JSON
 *                           body; reference images travel as complete
 *                           `data:image/...;base64,...` URLs inside `images[]`.
 *                           This is what SenseNova documents.
 *   apiStyle: 'multipart' — POST {baseUrl}/images/{generations|edits} as
 *                           multipart/form-data with the standard OpenAI fields
 *                           (`image[]` file parts, `model`, `prompt`, `size`, `n`).
 *
 * Both are synchronous, Bearer authenticated and return one image (b64_json or
 * a short-lived URL). Dimensions are read from the saved bytes, so a provider
 * that reports no size still produces a usable result.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'

export class ImageApiError extends Error {
  constructor(message, code = 'image_api_error') {
    super(message)
    this.name = 'ImageApiError'
    this.code = code
  }
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

const NAMED_SIZES = {
  '1:1': '2048x2048',
  '16:9': '2720x1536',
  '9:16': '1536x2720',
  '3:2': '2496x1664',
  '2:3': '1664x2496',
  '2k': '2048x2048',
  '4k': '4096x4096',
}

/** Map a friendly size to a provider size. Unknown text is returned as-is. */
export function mapSize(value, { strict = false } = {}) {
  const text = String(value || '').trim()
  if (!text || text.toLowerCase() === 'auto') return 'auto'
  const named = NAMED_SIZES[text.toLowerCase()]
  if (named) return named
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(text)
  if (match) {
    const width = Number(match[1])
    const height = Number(match[2])
    if (width % 32 === 0 && height % 32 === 0 && width >= 512 && width >= 512 && width <= 4096 && height <= 4096) {
      const ratio = Math.max(width / height, height / width)
      if (ratio <= 3) return `${width}x${height}`
    }
    if (!strict) return `${width}x${height}`
  }
  if (strict) {
    throw new ImageApiError(
      `不支持的尺寸 ${JSON.stringify(value)}：用 auto / 2K / 4K / 1:1 / 16:9 / 512–4096 且为 32 倍数的 WxH`,
      'invalid_size',
    )
  }
  return text
}

function mimeFor(path) {
  const mime = MIME[extname(path).toLowerCase()]
  if (!mime) throw new ImageApiError(`参考图格式仅支持 png/jpg/jpeg/webp: ${path}`, 'unsupported_ref')
  return mime
}

function dataUrlFor(path) {
  return `data:${mimeFor(path)};base64,${readFileSync(path).toString('base64')}`
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

async function request(url, options, timeoutMs, signal, what) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener?.('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 600)
      } catch {}
      throw new ImageApiError(`${what}失败: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`, 'http_error')
    }
    return response
  } catch (error) {
    if (error instanceof ImageApiError) throw error
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new ImageApiError('已取消', 'cancelled')
      throw new ImageApiError(`${what}超时（${Math.round(timeoutMs / 1000)}s）`, 'timeout')
    }
    throw new ImageApiError(`${what}失败: ${error?.message || error}`, 'network_error')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abort)
  }
}

function buildJsonBody({ model, prompt, refs, size, outputFormat, watermark, providerFields }) {
  const edit = refs.length > 0
  return {
    model,
    prompt,
    n: 1,
    size,
    response_format: 'b64_json',
    ...(providerFields
      ? {
          output_format: outputFormat,
          watermark: Boolean(watermark),
          prompt_extend: true,
        }
      : {}),
    ...(edit ? { images: refs.map((ref) => ({ image_url: dataUrlFor(ref) })) } : {}),
  }
}

function buildMultipartBody({ model, prompt, refs, size, outputFormat }) {
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append('n', '1')
  form.append('size', size)
  form.append('response_format', 'b64_json')
  if (outputFormat) form.append('output_format', outputFormat)
  for (const ref of refs) {
    const bytes = readFileSync(ref)
    form.append('image[]', new Blob([bytes], { type: mimeFor(ref) }), basename(ref))
  }
  return form
}

/**
 * Generate or edit one image through an OpenAI-Images-compatible endpoint.
 *
 * @returns {Promise<{path:string,width:number,height:number,bytes:number,model:string,size:string,endpoint:string}>}
 */
export async function generateWithProvider({
  apiKey,
  prompt,
  refs = [],
  size,
  out,
  model,
  baseUrl,
  apiStyle = 'json',
  providerFields = false,
  outputFormat = 'png',
  watermark = false,
  timeoutSec = 180,
  signal,
  label = '生图',
}) {
  if (!apiKey) throw new ImageApiError(`缺少 API key：在 Settings → 插件 → ShotFlow 里为该模型填入，或设置环境变量`, 'no_key')
  if (!prompt?.trim()) throw new ImageApiError('prompt 为空', 'invalid_prompt')
  if (refs.length > 5) throw new ImageApiError('最多 5 张参考图', 'too_many_refs')
  for (const ref of refs) if (!existsSync(ref)) throw new ImageApiError(`参考图不存在: ${ref}`, 'missing_ref')
  if (!out) throw new ImageApiError('缺少输出路径', 'missing_out')
  if (!baseUrl) throw new ImageApiError(`模型 ${model} 缺少 baseUrl`, 'missing_base_url')

  const resolvedSize = mapSize(size, { strict: apiStyle === 'json' && providerFields })
  const edit = refs.length > 0
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/images/${edit ? 'edits' : 'generations'}`
  const timeoutMs = Math.max(30, Number(timeoutSec) || 180) * 1000

  const options =
    apiStyle === 'multipart'
      ? {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}` },
          body: buildMultipartBody({ model, prompt: prompt.trim(), refs, size: resolvedSize, outputFormat }),
        }
      : {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(
            buildJsonBody({
              model,
              prompt: prompt.trim(),
              refs,
              size: resolvedSize,
              outputFormat,
              watermark,
              providerFields,
            }),
          ),
        }

  const response = await request(endpoint, options, timeoutMs, signal, label)
  const data = await response.json()
  const first = data?.data?.[0]
  let bytes
  if (first?.b64_json) {
    bytes = Buffer.from(String(first.b64_json), 'base64')
  } else if (first?.url) {
    const image = await request(first.url, {}, timeoutMs, signal, `下载${label}结果`)
    bytes = Buffer.from(await image.arrayBuffer())
  } else {
    throw new ImageApiError(`${label}响应里没有图片: ${JSON.stringify(data).slice(0, 400)}`, 'empty_image')
  }
  if (!bytes.length) throw new ImageApiError(`${label}返回了空图片`, 'empty_image')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, bytes)
  const dimensions = imageSize(bytes)
  return {
    path: out,
    width: dimensions.width,
    height: dimensions.height,
    bytes: bytes.length,
    model,
    size: data?.size || resolvedSize,
    endpoint,
  }
}
