/**
 * API-key resolution for DSH plugins.
 *
 * Order mirrors DSH's model settings:
 *   1. environment variable — always wins;
 *   2. DSH credential center (`ctx.credentials`) when no env var is set.
 *
 * Once the env var is present, writing to the credential center is refused, so
 * the UI cannot create a second, stale value beside the deployment secret.
 */

export const SERVICES = {
  sensenova: { env: 'SENSENOVA_API_KEY', label: 'SenseNova 图像 API' },
  pixmax: { env: 'PIXMAX_BEARER_TOKEN', label: 'Pixmax Bearer Token' },
}

export function serviceOf(name) {
  const key = String(name || '').toLowerCase()
  return SERVICES[key] ? { key, ...SERVICES[key] } : null
}

/** Resolve one secret without ever logging the value. */
export async function resolveSecret(ctx, service) {
  const meta = serviceOf(service)
  if (!meta) throw new Error(`未知的密钥服务: ${service}（可用: ${Object.keys(SERVICES).join(', ')}）`)
  const envValue = process.env[meta.env]
  if (typeof envValue === 'string' && envValue.trim()) {
    return { value: envValue.trim(), source: 'env', env: meta.env, canStore: false }
  }
  const credentials = ctx.get('credentials')
  if (!credentials?.resolve) {
    return { value: '', source: 'none', env: meta.env, canStore: false, error: '当前组合没有凭据服务（ctx.credentials）' }
  }
  try {
    const resolved = await credentials.resolve(meta.env)
    if (resolved?.value) {
      return { value: String(resolved.value), source: 'credentials', env: meta.env, canStore: true }
    }
  } catch (error) {
    return { value: '', source: 'none', env: meta.env, canStore: true, error: String(error?.message || error) }
  }
  return { value: '', source: 'none', env: meta.env, canStore: true }
}

export async function setSecret(ctx, service, value) {
  const meta = serviceOf(service)
  if (!meta) throw new Error(`未知的密钥服务: ${service}`)
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('value 不能为空')
  if (process.env[meta.env]) {
    throw new Error(`环境变量 ${meta.env} 已设置，按优先级不会再写入凭据中心；如需在凭据中心管理，请先移除该环境变量。`)
  }
  const credentials = ctx.get('credentials')
  if (!credentials?.set) throw new Error('当前组合没有凭据服务（ctx.credentials）')
  await credentials.set(meta.env, value.trim())
  return { set: true, env: meta.env, source: 'credentials' }
}

export async function clearSecret(ctx, service) {
  const meta = serviceOf(service)
  if (!meta) throw new Error(`未知的密钥服务: ${service}`)
  const credentials = ctx.get('credentials')
  if (!credentials?.unset) throw new Error('当前组合没有凭据服务（ctx.credentials）')
  await credentials.unset(meta.env)
  return { cleared: true, env: meta.env, envStillSet: Boolean(process.env[meta.env]) }
}

export async function secretStatus(ctx, service) {
  const resolved = await resolveSecret(ctx, service)
  return {
    service,
    env: resolved.env,
    configured: Boolean(resolved.value),
    source: resolved.source,
    envSet: resolved.source === 'env',
    canStore: resolved.canStore,
    ...(resolved.error ? { error: resolved.error } : {}),
  }
}
/* ------------------------------------------------------------------------- *
 * Generic per-model keys (used by the 生图模型列表).
 *
 * A model entry may declare `envKey` (the environment variable that always
 * wins) and `credentialName` (the DSH credential record). When neither is
 * declared the credential name is derived from the provider, so an endpoint
 * added in the settings page still has a stable place to keep its key.
 * ------------------------------------------------------------------------- */

function credentialNameFor(provider) {
  const slug = String(provider || 'provider')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `PIXMAX_WORKFLOW_IMAGE_${slug || 'PROVIDER'}_API_KEY`
}

/** Resolve the environment variable and credential record names of one model. */
export function keySpecOf(model = {}) {
  const envKey = String(model.envKey || '').trim()
  const credentialName = String(model.credentialName || envKey || credentialNameFor(model.provider)).trim()
  return { envKey, credentialName, provider: String(model.provider || ''), modelId: String(model.id || '') }
}

function credentialsService(ctx) {
  const credentials = ctx.get('credentials')
  if (!credentials?.resolve) throw new Error('当前组合没有凭据服务（ctx.credentials）')
  return credentials
}

/** Resolve one model's API key without ever logging the value. */
export async function resolveKey(ctx, model) {
  const spec = keySpecOf(model)
  if (spec.envKey) {
    const fromEnv = process.env[spec.envKey]
    if (typeof fromEnv === 'string' && fromEnv.trim()) {
      return { value: fromEnv.trim(), source: 'env', ...spec, canStore: false }
    }
  }
  const credentials = ctx.get('credentials')
  if (!credentials?.resolve) {
    return { value: '', source: 'none', ...spec, canStore: false, error: '当前组合没有凭据服务（ctx.credentials）' }
  }
  try {
    const resolved = await credentials.resolve(spec.credentialName)
    if (resolved?.value) return { value: String(resolved.value), source: 'credentials', ...spec, canStore: true }
  } catch (error) {
    return { value: '', source: 'none', ...spec, canStore: true, error: String(error?.message || error) }
  }
  return { value: '', source: 'none', ...spec, canStore: true }
}

/** Write one model's key into the DSH credential center. */
export async function setKey(ctx, model, value) {
  const spec = keySpecOf(model)
  if (typeof value !== 'string' || !value.trim()) throw new Error('value 不能为空')
  if (spec.envKey && process.env[spec.envKey]) {
    throw new Error(`环境变量 ${spec.envKey} 已设置，按优先级不会再写入凭据中心；如需在凭据中心管理，请先移除该环境变量。`)
  }
  const credentials = credentialsService(ctx)
  if (!credentials.set) throw new Error('当前组合没有凭据服务（ctx.credentials）')
  await credentials.set(spec.credentialName, value.trim())
  return { set: true, ...spec }
}

/** Remove one model's key from the DSH credential center. */
export async function clearKey(ctx, model) {
  const spec = keySpecOf(model)
  const credentials = credentialsService(ctx)
  if (!credentials.unset) throw new Error('当前组合没有凭据服务（ctx.credentials）')
  await credentials.unset(spec.credentialName)
  return { cleared: true, ...spec, envStillSet: Boolean(spec.envKey && process.env[spec.envKey]) }
}

/** Presence/source summary for the settings page. Never returns the value. */
export async function keyStatus(ctx, model) {
  const resolved = await resolveKey(ctx, model)
  return {
    configured: Boolean(resolved.value),
    source: resolved.source,
    envKey: resolved.envKey,
    credentialName: resolved.credentialName,
    envSet: resolved.source === 'env',
    canStore: resolved.canStore,
    ...(resolved.error ? { error: resolved.error } : {}),
  }
}
