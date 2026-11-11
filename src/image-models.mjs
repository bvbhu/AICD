/**
 * Image model registry + user settings for the dsh-pixmax-workflow image tools.
 *
 * The 生图模型列表 lives in one JSON file next to the tool outputs
 * (`<root>/settings.json`), so the settings page can edit it without touching
 * the profile's cordis.patch.yml and without restarting the plugin. Every model
 * is addressed by `provider/model` — the browser channel is
 * `browser/gpt-image-2`, every OpenAI-compatible endpoint uses whatever
 * `provider/modelid` the endpoint documents.
 *
 * API keys never live in this file: they are resolved per model from an
 * environment variable (which always wins) or from the DSH credential center
 * under the same name, exactly like DSH's own model settings.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defaultPluginRoot } from './store.mjs'

export const SETTINGS_VERSION = 1
export const BROWSER_MODEL_ID = 'browser/gpt-image-2'

/**
 * Only the browser channel ships built-in. Every OpenAI-compatible endpoint —
 * including SenseNova — is a user model in `<root>/settings.json`, so it can be
 * edited (or removed) from the plugin settings page without a code change.
 */
export const BUILTIN_MODELS = [
  {
    id: BROWSER_MODEL_ID,
    label: 'ChatGPT 网页 · gpt-image-2',
    kind: 'browser',
    provider: 'browser',
    model: 'gpt-image-2',
    builtin: true,
    note: '走已登录的 Chrome（无需 API key，用网页额度）；支持参考图/改图；分钟级；可能被 Cloudflare 拦；固定输出 PNG。',
  },
]

const ID_RE = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]*$/

export function settingsFile(root) {
  return join(root || defaultPluginRoot(), 'settings.json')
}

function emptySettings() {
  return { version: SETTINGS_VERSION, defaultModel: BROWSER_MODEL_ID, disabledBuiltins: [], models: [] }
}

/** Read the settings file; a missing or broken file degrades to defaults. */
export function loadImageSettings(root) {
  const path = settingsFile(root)
  if (!existsSync(path)) return { ...emptySettings(), path, exists: false }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return normalizeSettings(parsed, path)
  } catch {
    return { ...emptySettings(), path, exists: true, broken: true }
  }
}

function normalizeSettings(raw, path) {
  const base = emptySettings()
  const disabled = Array.isArray(raw?.disabledBuiltins)
    ? raw.disabledBuiltins.map((value) => String(value || '').trim()).filter(Boolean)
    : base.disabledBuiltins
  const models = []
  for (const entry of Array.isArray(raw?.models) ? raw.models : []) {
    const normalized = normalizeModel(entry)
    if (normalized.ok) models.push(normalized.model)
  }
  const settings = {
    version: SETTINGS_VERSION,
    defaultModel: typeof raw?.defaultModel === 'string' && raw.defaultModel.trim() ? raw.defaultModel.trim() : base.defaultModel,
    disabledBuiltins: disabled,
    models,
  }
  return { ...settings, path, exists: true }
}

/** Validate one model entry; throws-free so both the tool and the page can use it. */
export function normalizeModel(entry) {
  const raw = entry && typeof entry === 'object' ? entry : {}
  const id = String(raw.id || '').trim()
  if (!ID_RE.test(id)) return { ok: false, error: `模型 id 必须是 provider/model 形式（例如 openai/gpt-image-1）：${JSON.stringify(id)}` }
  const kind = raw.kind === 'browser' ? 'browser' : 'openai'
  const [idProvider, idModel] = id.split('/')
  const provider = String(raw.provider || idProvider).trim()
  if (!PROVIDER_RE.test(provider)) return { ok: false, error: `provider 只能是字母数字与 ._-：${JSON.stringify(provider)}` }
  const model = String(raw.model || idModel).trim()
  if (!model) return { ok: false, error: `模型 ${id} 缺少 model` }
  const model_ = {
    id,
    label: String(raw.label || id).trim().slice(0, 120) || id,
    kind,
    provider,
    model,
  }
  if (kind === 'browser') {
    if (provider !== 'browser') return { ok: false, error: '浏览器渠道的 id 必须是 browser/<模型名>' }
    model_.apiStyle = 'browser'
  } else {
    const baseUrl = String(raw.baseUrl || '').trim()
    if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: `模型 ${id} 需要 http(s) baseUrl` }
    model_.baseUrl = baseUrl.replace(/\/+$/, '')
    const apiStyle = raw.apiStyle === 'multipart' ? 'multipart' : 'json'
    model_.apiStyle = apiStyle
    const envKey = String(raw.envKey || '').trim()
    if (envKey && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) return { ok: false, error: `envKey 不是合法的环境变量名：${envKey}` }
    model_.envKey = envKey
    if (raw.credentialName !== undefined) {
      const name = String(raw.credentialName || '').trim()
      if (name) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, error: `credentialName 不是合法的凭据名：${name}` }
        model_.credentialName = name
      }
    }
  }
  if (raw.note !== undefined) model_.note = String(raw.note || '').slice(0, 400)
  return { ok: true, model: model_ }
}

/** Builtins (minus disabled/overridden) followed by user models. */
export function effectiveModels(settings) {
  const disabled = new Set(settings?.disabledBuiltins || [])
  const userModels = (settings?.models || []).filter((model) => !model.builtin)
  const userIds = new Set(userModels.map((model) => model.id))
  const builtins = BUILTIN_MODELS.filter((model) => !disabled.has(model.id) && !userIds.has(model.id))
  return [...builtins.map((model) => ({ ...model })), ...userModels.map((model) => ({ ...model }))]
}

/**
 * Resolve `provider/model` plus friendly aliases. `sensenova` is only a
 * shortcut to the user-configured endpoint — it is not a built-in model, so it
 * resolves only while that endpoint exists in settings.json.
 */
export function resolveImageModel(settings, requested) {
  const models = effectiveModels(settings)
  const fallbackId = settings?.defaultModel || BROWSER_MODEL_ID
  const text = String(requested || '').trim()
  const aliases = {
    browser: BROWSER_MODEL_ID,
    'gpt-image': BROWSER_MODEL_ID,
    'gpt-image-2': BROWSER_MODEL_ID,
    sensenova: 'sensenova/sensenova-u1.5-lite',
  }
  const wanted = text || fallbackId
  const id = aliases[wanted] || wanted
  const found = models.find((model) => model.id === id)
  if (found) return { model: found, models }
  const byModelCode = models.find((model) => model.model === id)
  if (byModelCode) return { model: byModelCode, models }
  throw new Error(
    `未知的生图模型 ${JSON.stringify(text || '(未指定)')}。可用的模型：${models.map((model) => model.id).join(', ') || '(空)'}。` +
      '用 model_list 查看，或在 Settings → 插件 → dsh-pixmax-workflow 里新增。',
  )
}

/** Persist a settings document (atomic replace; keeps a strict shape). */
export function saveImageSettings(root, next) {
  const normalized = normalizeSettings(next, settingsFile(root))
  const ids = new Set()
  for (const model of normalized.models) {
    if (ids.has(model.id)) throw new Error(`模型 id 重复：${model.id}`)
    ids.add(model.id)
  }
  if (normalized.defaultModel && !effectiveModels(normalized).some((model) => model.id === normalized.defaultModel)) {
    normalized.defaultModel = effectiveModels(normalized)[0]?.id || BROWSER_MODEL_ID
  }
  const path = settingsFile(root)
  mkdirSync(dirname(path), { recursive: true })
  const payload = {
    version: SETTINGS_VERSION,
    defaultModel: normalized.defaultModel,
    disabledBuiltins: normalized.disabledBuiltins,
    models: normalized.models,
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return { ...payload, path, exists: true }
}

/** Public view of one model for tools and the settings page. */
export function describeModel(model, keyState) {
  return {
    id: model.id,
    label: model.label,
    kind: model.kind,
    provider: model.provider,
    model: model.model,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.apiStyle ? { apiStyle: model.apiStyle } : {}),
    ...(model.envKey ? { envKey: model.envKey } : {}),
    ...(model.credentialName ? { credentialName: model.credentialName } : {}),
    builtin: Boolean(model.builtin),
    ...(model.note ? { note: model.note } : {}),
    ...(keyState ? { key: keyState } : {}),
  }
}
