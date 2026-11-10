/**
 * Read-only Pixmax CLI tools.
 *
 * These wrap the high-level, credit-free commands only: doctor/status, project
 * and canvas inspection, node/model queries, task progress and templates.
 * Generate/submit/upload/update/delete/raw are deliberately not exposed — the
 * tool cannot spend Pixmax credits or mutate a canvas.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveSecret } from './credentials.mjs'

export const name = 'dsh-shotflow-pixmax'
export const inject = ['tools']

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function resolvePixmax(config = {}) {
  const home = config.pixmaxHome || join(homedir(), '.pixmax-cli')
  const launcher = readJson(join(home, 'launcher-config.json')) || {}
  const current = readJson(join(home, 'runtime', 'current.json')) || {}
  const python = config.pixmaxPython || launcher.installedPython || 'python'
  const runtimeDir = current.runtimeDir ? join(home, current.runtimeDir) : ''
  const entry = config.pixmaxEntry || (runtimeDir ? join(runtimeDir, 'entry.py') : '')
  const launcherPath = config.pixmaxPath || ''
  return { home, python, entry, launcherPath, environment: config.environment || '' }
}

function quoteArg(value) {
  const text = String(value)
  if (!/[\s"]/u.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

function runCommand({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-512 * 1024)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false })
    })
  })
}

function parseJson(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {}
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {}
  }
  return null
}

function required(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`action 需要参数 ${name}`)
  return value.trim()
}

const ACTIONS = {
  doctor: (a) => ['doctor', ...(a.online ? ['--online'] : [])],
  session_status: () => ['session', 'status'],
  config_show: () => ['config', 'show'],
  capabilities_matrix: () => ['capabilities', 'matrix'],
  capabilities_probe: () => ['capabilities', 'probe'],
  auth_status: () => ['auth', 'login', 'status'],
  auth_whoami: () => ['auth', 'whoami'],
  auth_credit: () => ['auth', 'credit'],
  profile_list: () => ['auth', 'profile', 'list'],
  project_list: () => ['project', 'list'],
  project_info: () => ['project', 'info'],
  project_files: () => ['project', 'files'],
  canvas_get: () => ['canvas', 'get'],
  canvas_summary: () => ['canvas', 'summary', '--no-prompts'],
  canvas_nodes: (a) => ['canvas', 'nodes', ...(a.generated ? ['--generated'] : [])],
  canvas_model_config: () => ['canvas', 'model-config'],
  node_get: (a) => ['node', 'get', required(a.selector, 'selector')],
  node_list: (a) => ['node', 'list', ...(a.generated ? ['--generated'] : [])],
  model_search: (a) => ['model', 'search', '--type', a.type || 'GENERATE_IMAGE', ...(a.query ? [a.query] : [])],
  model_get: (a) => ['model', 'get', required(a.selector, 'selector')],
  model_explain: (a) => ['model', 'explain', required(a.selector, 'selector')],
  tasks_list: () => ['tasks', 'list'],
  tasks_history: () => ['tasks', 'history'],
  tasks_detail: (a) => ['tasks', 'detail', required(a.selector, 'selector')],
  tasks_progress: (a) => ['tasks', 'progress', required(a.selector, 'selector')],
  tasks_wait: (a) => ['tasks', 'wait', required(a.selector, 'selector')],
  templates_list: () => ['templates', 'list'],
  templates_get: (a) => ['templates', 'get', required(a.selector, 'selector')],
  templates_categories: () => ['templates', 'categories'],
  workflow_list: () => ['workflow', 'list'],
  workflow_show: (a) => ['workflow', 'show', required(a.selector, 'selector')],
}

async function runPixmax(ctx, config, action, args) {
  const build = ACTIONS[action]
  if (!build) throw new Error(`不支持的 action: ${action}`)
  const resolved = resolvePixmax(config)
  const secret = await resolveSecret(ctx, 'pixmax')
  const env = {
    ...process.env,
    PIXMAX_CLI_HOME: resolved.home,
    PYTHONUTF8: '1',
  }
  if (resolved.environment) env.PIXMAX_ENV = resolved.environment
  if (secret.value) env.PIXMAX_BEARER_TOKEN = secret.value

  let command
  let commandArgs
  if (resolved.entry && existsSync(resolved.entry) && existsSync(resolved.python)) {
    command = resolved.python
    commandArgs = [resolved.entry, '--json', ...build(args)]
  } else {
    const launcher = resolved.launcherPath || (process.platform === 'win32' ? 'pixmax.cmd' : 'pixmax')
    command = process.env.ComSpec || 'cmd.exe'
    commandArgs = ['/d', '/s', '/c', `${quoteArg(launcher)} --json ${build(args).map(quoteArg).join(' ')}`]
  }
  const timeoutMs = Math.max(10, Math.min(600, Number(args.timeout || config.timeoutSec || 120))) * 1000
  const started = Date.now()
  const result = await runCommand({ command, args: commandArgs, cwd: resolved.home, env, timeoutMs })
  const data = parseJson(result.stdout)
  const ok = !result.timedOut && result.code === 0 && data?.ok !== false
  return {
    action,
    ok,
    exitCode: result.code,
    timedOut: result.timedOut,
    ms: Date.now() - started,
    json: data ? JSON.stringify(data) : '',
    text: String(data ? '' : result.stdout || '').trim().slice(0, 8000),
    stderr: result.stderr.trim().slice(0, 4000),
    source: resolved.entry && existsSync(resolved.entry) ? 'entry' : 'launcher',
  }
}

export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: 'pixmax',
    description:
      '只读查询 Pixmax 工作区：doctor/登录/项目/画布/节点/模型/任务/模板。' +
      '本工具不提供任何会消耗积分或修改画布的操作（没有 generate/submit/upload/create/update/delete/run/raw）。' +
      'action: doctor | session_status | config_show | capabilities_matrix | capabilities_probe | auth_status | auth_whoami | auth_credit | profile_list | project_list | project_info | project_files | canvas_get | canvas_summary | canvas_nodes | canvas_model_config | node_get | node_list | model_search | model_get | model_explain | tasks_list | tasks_history | tasks_detail | tasks_progress | tasks_wait | templates_list | templates_get | templates_categories | workflow_list | workflow_show。' +
      '需要 selector/query/type 的 action 会明确报错；命令固定加 --json。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: str('要执行的只读查询（见工具描述）'),
        selector: str('节点/模型/任务/模板/工作流的 label、uuid 或 nodeKey'),
        query: str('model_search 的搜索词'),
        type: str('model_search 的节点类型，默认 GENERATE_IMAGE'),
        generated: bool('canvas_nodes / node_list 只看已生成节点'),
        online: bool('doctor 是否调用 /user/info 验证 token（仍然只读）'),
        timeout: num('命令超时秒数（默认 120，最大 600）'),
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          action: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { type: 'number' },
          timedOut: { type: 'boolean' },
          ms: { type: 'number' },
          source: { type: 'string' },
          json: { type: 'string' },
          text: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['status', 'action', 'ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `pixmax ${value.action}: ${value.ok ? 'ok' : 'failed'}${value.timedOut ? ' (timeout)' : ''} (${value.ms}ms, ${value.source})`,
          value.json ? value.json.slice(0, 12000) : value.text,
          value.stderr ? `[stderr]\n${value.stderr}` : '',
        ].filter(Boolean).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action || '')
      try {
        const result = await runPixmax(ctx, config, action, args)
        return { status: result.ok ? 'completed' : 'failed', ...result }
      } catch (error) {
        return {
          status: 'failed',
          action,
          ok: false,
          exitCode: -1,
          timedOut: false,
          ms: 0,
          source: 'none',
          json: '',
          text: String(error?.message || error),
          stderr: '',
        }
      }
    },
  })

  ctx.logger?.info?.(`[dsh-shotflow-pixmax] read-only pixmax tool registered (home ${resolvePixmax(config).home})`)
}
