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
