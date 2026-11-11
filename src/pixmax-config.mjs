/**
 * Persisted Pixmax CLI settings.
 *
 * The CLI home (and optional environment) can be edited from the plugin's
 * settings card, which talks to the `/cli` route in `settings-host.mjs`.
 * `pixmax-tools.mjs` reads this file only when the tool is called, so a missing
 * or wrong path never breaks plugin registration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { defaultPluginRoot } from './store.mjs'

export const DEFAULT_CLI_HOME = join(homedir(), '.pixmax-cli')

export function cliConfigPath(root = defaultPluginRoot()) {
  return join(root, 'pixmax-cli.json')
}

export function loadCliConfig(root = defaultPluginRoot()) {
  const path = cliConfigPath(root)
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const home = typeof data.home === 'string' ? data.home.trim() : ''
    return {
      path,
      home,
      environment: typeof data.environment === 'string' ? data.environment.trim() : '',
      configured: home.length > 0,
    }
  } catch {
    return { path, home: '', environment: '', configured: false }
  }
}

export function saveCliConfig(root = defaultPluginRoot(), input = {}) {
  const home = String(input.home ?? '').trim()
  const environment = String(input.environment ?? '').trim()
  if (home.length > 500) throw new Error('CLI 路径过长（最多 500 字符）')
  if (environment && environment !== 'cn' && environment !== 'global') {
    throw new Error('PIXMAX_ENV 只能是 cn 或 global')
  }
  const path = cliConfigPath(root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ home, environment }, null, 2)}\n`, 'utf8')
  return { path, home, environment, configured: home.length > 0 }
}

/** Read-only view used by the settings card. No validation errors here. */
export function describeCliConfig(root = defaultPluginRoot()) {
  const config = loadCliConfig(root)
  const effectiveHome = config.home || DEFAULT_CLI_HOME
  return {
    ...config,
    defaultHome: DEFAULT_CLI_HOME,
    effectiveHome,
    source: config.configured ? 'settings' : 'default',
    exists: existsSync(effectiveHome),
  }
}
