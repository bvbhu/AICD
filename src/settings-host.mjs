/**
 * Host half of the dsh-pixmax-workflow settings page.
 *
 * The browser card (`client/pixmax-workflow-settings.js`) reads and writes through the
 * small JSON bridge registered here — the same pattern the DSH plugin pages use:
 *
 *   GET  /api/dsh-pixmax-workflow/state   → builtins + user models + default + key status
 *   POST /api/dsh-pixmax-workflow/save    → save the model list / default model
 *   POST /api/dsh-pixmax-workflow/key     → status | set | clear one model's API key
 *   GET  /api/dsh-pixmax-workflow/cli     → Pixmax CLI home / environment (settings card)
 *   POST /api/dsh-pixmax-workflow/cli/set → save the Pixmax CLI home / environment
 *   GET  /api/dsh-pixmax-workflow/credit  → whether credit-spending submissions are allowed
 *   POST /api/dsh-pixmax-workflow/credit/set → toggle credit-spending submissions
 *   GET  /api/dsh-pixmax-workflow/health  → liveness and the settings file path
 *
 * Model definitions live in `<root>/settings.json`; API keys live in the DSH
 * credential center (environment variables still win). Nothing here spends
 * credits, calls a provider, or touches the profile's cordis.patch.yml.
 */

import { keyStatus, clearKey, setKey } from './credentials.mjs'
import {
  BROWSER_MODEL_ID,
  BUILTIN_MODELS,
  describeModel,
  effectiveModels,
  loadImageSettings,
  normalizeModel,
  saveImageSettings,
} from './image-models.mjs'
import { defaultPluginRoot } from './store.mjs'
import { describeCliConfig, loadCreditPolicy, saveCliConfig, saveCreditPolicy } from './pixmax-config.mjs'

export const name = 'dsh-pixmax-workflow'
export const inject = ['webServer']

const PREFIX = '/api/dsh-pixmax-workflow'
const MAX_BODY = 256 * 1024

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Only same-origin/loopback callers may use the bridge: the settings page is
 * served by this very server, so a browser request always carries its own
 * origin (or none, for same-origin GETs).
 */
function trusted(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || !host) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== 'null') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

async function describeAll(ctx, root) {
  const settings = loadImageSettings(root)
  const disabled = new Set(settings.disabledBuiltins || [])
  const builtins = []
  for (const model of BUILTIN_MODELS) {
    const state = model.kind === 'browser' ? { configured: true, source: 'browser' } : await keyStatus(ctx, model)
    builtins.push({ ...describeModel(model, state), disabled: disabled.has(model.id) })
  }
  const userModels = []
  for (const model of effectiveModels(settings).filter((entry) => !entry.builtin)) {
    userModels.push(describeModel(model, model.kind === 'browser' ? { configured: true, source: 'browser' } : await keyStatus(ctx, model)))
  }
  return {
    ok: true,
    path: settings.path,
    root,
    defaultModel: settings.defaultModel || BROWSER_MODEL_ID,
    disabledBuiltins: [...disabled],
    builtins,
    models: userModels,
  }
}

function badRequest(res, message, extra = {}) {
  writeJson(res, 400, { ok: false, error: String(message), ...extra })
}

function findModel(settings, modelId) {
  const id = String(modelId || '').trim()
  if (!id) throw new Error('缺少 modelId')
  const found = effectiveModels(settings).find((model) => model.id === id) ||
    BUILTIN_MODELS.find((model) => model.id === id)
  if (!found) throw new Error(`未知的生图模型: ${id}`)
  return found
}

function buildRoutes({ ctx, config }) {
  const root = config.root || defaultPluginRoot()

  async function state() {
    return await describeAll(ctx, root)
  }

  async function save(body) {
    const models = []
    for (const entry of Array.isArray(body?.models) ? body.models : []) {
      const normalized = normalizeModel({ ...entry, builtin: false })
      if (!normalized.ok) throw new Error(normalized.error)
      models.push({ ...normalized.model, builtin: false })
    }
    const ids = new Set()
    for (const model of models) {
      if (ids.has(model.id)) throw new Error(`模型 id 重复: ${model.id}`)
      ids.add(model.id)
      if (BUILTIN_MODELS.some((builtin) => builtin.id === model.id)) {
        throw new Error(`${model.id} 是内置模型，不能重复添加；需要改端点就新增一个不同 id 的模型`)
      }
    }
    const disabledBuiltins = (Array.isArray(body?.disabledBuiltins) ? body.disabledBuiltins : [])
      .map((value) => String(value || '').trim())
      .filter((value) => BUILTIN_MODELS.some((builtin) => builtin.id === value))
    const defaultModel = String(body?.defaultModel || '').trim()
    const known = [...BUILTIN_MODELS.filter((model) => !disabledBuiltins.includes(model.id)), ...models].map((model) => model.id)
    if (defaultModel && !known.includes(defaultModel)) throw new Error(`默认模型不在可用列表里: ${defaultModel}`)
    saveImageSettings(root, {
      defaultModel: defaultModel || known[0] || BROWSER_MODEL_ID,
      disabledBuiltins,
      models,
    })
    return await state()
  }

  async function keyAction(body) {
    const action = String(body?.action || 'status')
    const settings = loadImageSettings(root)
    const model = findModel(settings, body?.modelId)
    if (model.kind === 'browser') throw new Error('浏览器渠道不需要 API key')
    if (action === 'status') return await state()
    if (action === 'set') {
      if (typeof body?.value !== 'string' || !body.value.trim()) throw new Error('value 不能为空')
      await setKey(ctx, model, body.value)
      return await state()
    }
    if (action === 'clear') {
      await clearKey(ctx, model)
      return await state()
    }
    throw new Error(`不支持的 key action: ${action}`)
  }

  const route = (path, method, handler) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!trusted(req)) {
        writeJson(res, 403, { ok: false, error: '仅允许来自 DSH 页面本身的请求' })
        return
      }
      if (String(req.method || '').toUpperCase() !== method) {
        writeJson(res, 405, { ok: false, error: `只支持 ${method}` })
        return
      }
      try {
        if (method === 'GET') {
          writeJson(res, 200, await handler({}))
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined) {
          badRequest(res, '请求体不是合法 JSON（或超过 256 KB）')
          return
        }
        writeJson(res, 200, await handler(body))
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  })

  return [
    route(`${PREFIX}/state`, 'GET', () => state()),
    route(`${PREFIX}/save`, 'POST', (body) => save(body)),
    route(`${PREFIX}/key`, 'POST', (body) => keyAction(body)),
    route(`${PREFIX}/cli`, 'GET', () => ({ ok: true, ...describeCliConfig(root) })),
    route(`${PREFIX}/cli/set`, 'POST', (body) => {
      saveCliConfig(root, body)
      return { ok: true, ...describeCliConfig(root) }
    }),
    route(`${PREFIX}/credit`, 'GET', () => ({ ok: true, ...loadCreditPolicy(root) })),
    route(`${PREFIX}/credit/set`, 'POST', (body) => {
      if (body?.allowCreditTasks !== true && body?.allowCreditTasks !== false) {
        throw new Error('allowCreditTasks 必须是 true 或 false')
      }
      return { ok: true, ...saveCreditPolicy(root, body.allowCreditTasks) }
    }),
    route(`${PREFIX}/health`, 'GET', () => ({ ok: true, root, path: loadImageSettings(root).path })),
  ]
}

export function apply(ctx, config = {}) {
  // Cordis passes `config: null` for rows whose YAML config is empty.
  config = config || {}
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const server = sctx.get('webServer')
      const disposers = buildRoutes({ ctx, config }).map((entry) => server.register(entry))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {}
        }
      }
    }, 'pixmax-workflow: settings bridge')
  })
  ctx.logger?.info?.(`[dsh-pixmax-workflow] settings bridge registered under ${PREFIX}`)
}
