/**
 * SenseNova U1.5 image backend — compatibility wrapper.
 *
 * The real work moved to `image-api.mjs`, which serves every OpenAI-Images-style
 * model configured in the ShotFlow settings page (SenseNova is one of them).
 * This module keeps the historical export names so older call sites and the
 * package's `./sensenova` export keep working.
 *
 *   POST {baseUrl}/images/generations
 *   POST {baseUrl}/images/edits        (reference images travel as data: URLs)
 */

import { ImageApiError, generateWithProvider, mapSize } from './image-api.mjs'

export { mapSize }

/** Historical error class; every API failure is thrown as this type. */
export class SenseNovaError extends ImageApiError {
  constructor(message, code = 'sensenova_error') {
    super(message, code)
    this.name = 'SenseNovaError'
  }
}

export const DEFAULT_BASE = 'https://token.sensenova.cn/v1'
export const DEFAULT_MODEL = 'sensenova-u1.5-lite'

/**
 * Generate or edit one image with SenseNova U1.5.
 * @returns {Promise<{path:string,width:number,height:number,bytes:number,model:string,size:string}>}
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
  try {
    return await generateWithProvider({
      apiKey,
      prompt,
      refs,
      size,
      out,
      model,
      baseUrl,
      apiStyle: 'json',
      providerFields: true,
      outputFormat,
      watermark,
      timeoutSec,
      signal,
      label: refs.length > 0 ? 'SenseNova 图片编辑' : 'SenseNova 生图',
    })
  } catch (error) {
    if (error instanceof SenseNovaError) throw error
    throw new SenseNovaError(error?.message || String(error), error?.code || 'sensenova_error')
  }
}
