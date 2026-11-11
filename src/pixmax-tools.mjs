/**
 * Pixmax CLI tools — every operation that cannot spend credits.
 *
 * The tool exposes the whole credit-free surface of the Pixmax CLI: reads
 * (doctor/auth/project/canvas/node/model/task/template/workflow/skill) and free
 * writes (node create/update/delete/batch, asset upload/download, project file
 * operations, script/storyboard node creation, raw canvas mutations).
 *
 * What it refuses, by construction:
 *   - any argv containing a submit flag (`--run` and friends), so an
 *     image/video/storyboard/generate node can be created but never submitted;
 *   - the raw submit commands (`tasks quick-submit|submit-batch|template-submit`,
 *     `group run`, `video generate-final` without `--dry-run`);
 *   - `raw <method>` for anything but GET;
 *   - `repl` (interactive) and the CLI's own credential/path overrides.
 *
 * Anything else — including `command: ["node","create",...]` — runs as-is with
 * `--json`, and `--dry-run` is always allowed.
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
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description })

/** Flags that submit a generation task (and therefore spend credits). */
const SUBMIT_FLAGS = new Set(['--run', '--submit', '--execute', '--live'])
/** Command paths that submit on their own, with no --run flag involved. */
const SUBMIT_PATHS = [
  ['tasks', 'quick-submit'],
  ['tasks', 'submit-batch'],
  ['tasks', 'template-submit'],
  ['group', 'run'],
]
/** Submit-only commands that stay available in planning mode (--dry-run). */
const DRY_RUN_ONLY = [['video', 'generate-final']]
/** Root commands the tool may call. */
const ROOTS = new Set([
  'assets',
  'auth',
  'canvas',
  'capabilities',
  'config',
  'doctor',
  'group',
  'image',
  'model',
  'node',
  'project',
  'raw',
  'script',
  'session',
  'skill',
  'storyboard',
  'tasks',
  'templates',
  'update',
  'video',
  'workflow',
])
/** Root-level options that must stay under the plugin's control. */
const FORBIDDEN_FLAGS = new Set(['--token', '--session-file', '--config-file', '--base-url', '--environment'])

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

/** Friendly `action` shorthands; each returns the argv after `pixmax`. */
const ACTIONS = {
  doctor: (a) => ['doctor', ...(a.online ? ['--online'] : [])],
  session_status: () => ['session', 'status'],
  session_clear: () => ['session', 'clear'],
  config_show: () => ['config', 'show'],
  capabilities_matrix: () => ['capabilities', 'matrix'],
  capabilities_probe: () => ['capabilities', 'probe'],
  auth_status: () => ['auth', 'login', 'status'],
  auth_whoami: () => ['auth', 'whoami'],
  auth_credit: () => ['auth', 'credit'],
  auth_profiles: () => ['auth', 'profile', 'list'],
  project_list: () => ['project', 'list'],
  project_info: () => ['project', 'info'],
  project_files: () => ['project', 'files'],
  project_use: (a) => ['project', 'use', ...(a.selector ? [a.selector] : []), ...(a.file ? ['--file', a.file] : [])],
  project_file_create: (a) => ['project', 'file', 'create', ...selectorFlag(a), ...flag('--name', a.name), ...flag('--type', a.type)],
  project_file_rename: (a) => ['project', 'file', 'rename', ...selectorFlag(a), ...flag('--name', a.name)],
  project_file_move: (a) => ['project', 'file', 'move', ...selectorFlag(a), ...flag('--parent', a.parent)],
  project_file_delete: (a) => ['project', 'file', 'delete', ...selectorFlag(a)],
  canvas_get: () => ['canvas', 'get'],
  canvas_summary: () => ['canvas', 'summary', '--no-prompts'],
  canvas_nodes: (a) => ['canvas', 'nodes', ...(a.generated ? ['--generated'] : [])],
  canvas_model_config: () => ['canvas', 'model-config'],
  canvas_export: (a) => ['canvas', 'export', ...flag('--out', a.out)],
  canvas_batch: (a) => ['canvas', 'batch', ...flag('--data', a.data), ...flag('--file', a.plan_file), ...planOnly(a)],
  canvas_node: (a) => ['canvas', 'node', required(a.command, 'command').toLowerCase(), ...planOnly(a)],
  node_get: (a) => ['node', 'get', required(a.selector, 'selector')],
  node_list: (a) => ['node', 'list', ...(a.generated ? ['--generated'] : [])],
  node_create: (a) => [
    'node',
    'create',
    required(a.selector, 'selector'),
    ...flag('--type', a.type || 'GENERATE_IMAGE'),
    ...flag('--prompt', a.prompt),
    ...flag('--model', a.model),
    ...flags('-s', a.set),
    ...flags('-u', a.update),
    ...flags('--left', a.left),
    ...flag('--x', a.x),
    ...flag('--y', a.y),
    ...planOnly(a),
  ],
  node_update: (a) => [
    'node',
    'update',
    required(a.selector, 'selector'),
    ...flag('--name', a.name),
    ...flag('--prompt', a.prompt),
    ...flag('--model', a.model),
    ...flags('-s', a.set),
    ...flags('-u', a.update),
    ...flags('--left', a.left),
    ...flags('--left-add', a.left_add),
    ...flags('--left-set', a.left_set),
    ...(a.left_clear ? ['--left-clear'] : []),
    ...flags('--left-rm', a.left_rm),
    ...flag('--group', a.group),
    ...planOnly(a),
  ],
  node_delete: (a) => ['node', 'delete', required(a.selector, 'selector')],
  node_batch: (a) => ['node', 'batch', ...flag('--data', a.data), ...flag('--plan-file', a.plan_file), ...planOnly(a)],
  model_search: (a) => ['model', 'search', '--type', a.type || 'GENERATE_IMAGE', ...(a.query ? [a.query] : [])],
  model_get: (a) => ['model', 'get', required(a.selector, 'selector')],
  model_explain: (a) => ['model', 'explain', required(a.selector, 'selector')],
  image_generate: (a) => [
    'image',
    'generate',
    required(a.selector, 'selector'),
    ...flag('--prompt', a.prompt),
    ...flag('--model', a.model),
    ...flag('--resolution', a.resolution),
    ...flag('--aspect-ratio', a.aspect_ratio),
    ...flag('--count', a.count),
    ...flags('-s', a.set),
    ...flag('--x', a.x),
    ...flag('--y', a.y),
    ...planOnly(a),
  ],
  image_edit: (a) => [
    'image',
    'edit',
    required(a.selector, 'selector'),
    ...flag('--image-node', required(a.image_node, 'image_node')),
    ...flag('--prompt', a.prompt),
    ...flag('--model', a.model),
    ...flag('--resolution', a.resolution),
    ...flag('--aspect-ratio', a.aspect_ratio),
    ...flag('--count', a.count),
    ...flags('-s', a.set),
    ...flag('--x', a.x),
    ...flag('--y', a.y),
    ...planOnly(a),
  ],
  video_image_to_video: (a) => [
    'video',
    'image-to-video',
    required(a.selector, 'selector'),
    ...flag('--image-node', required(a.image_node, 'image_node')),
    ...flag('--prompt', a.prompt),
    ...flag('--model', a.model),
    ...flag('--resolution', a.resolution),
    ...flag('--aspect-ratio', a.aspect_ratio),
    ...flag('--duration', a.duration),
    ...(a.include_audio === true ? ['--include-audio'] : []),
    ...flag('--count', a.count),
    ...flags('-s', a.set),
    ...flag('--x', a.x),
    ...flag('--y', a.y),
    ...planOnly(a),
  ],
  video_text_to_video: (a) => [
    'video',
    'text-to-video',
    required(a.selector, 'selector'),
    ...flag('--prompt', a.prompt),
    ...flag('--model', a.model),
    ...flag('--resolution', a.resolution),
    ...flag('--aspect-ratio', a.aspect_ratio),
    ...flag('--duration', a.duration),
    ...(a.include_audio === true ? ['--include-audio'] : []),
    ...flag('--count', a.count),
    ...flags('-s', a.set),
    ...flag('--x', a.x),
    ...flag('--y', a.y),
    ...planOnly(a),
  ],
  storyboard_config: () => ['storyboard', 'config'],
  storyboard_create: (a) => [
    'storyboard',
    'create',
    required(a.selector, 'selector'),
    ...flag('--prompt', a.prompt),
    ...flag('--model', a.model),
    ...flag('--grid', a.grid),
    ...flag('--resolution', a.resolution),
    ...flag('--aspect-ratio', a.aspect_ratio),
    ...flags('--left', a.left),
    ...flags('-s', a.set),
    ...flag('--x', a.x),
    ...flag('--y', a.y),
    ...planOnly(a),
  ],
  script_create: (a) => ['script', 'create', required(a.selector, 'selector'), ...flag('--text', a.text), ...flags('-s', a.set)],
  script_rows: (a) => ['script', 'rows', required(a.selector, 'selector')],
  script_set_rows: (a) => ['script', 'set-rows', required(a.selector, 'selector'), ...flags('--row', a.rows)],
  script_storyboard: (a) => [
    'script',
    'storyboard',
    required(a.selector, 'selector'),
    ...flag('--model', a.model),
    ...flag('--resolution', a.resolution),
    ...flag('--aspect-ratio', a.aspect_ratio),
    ...flag('--count', a.count),
    ...flags('-s', a.set),
    ...planOnly(a),
  ],
  assets_list: () => ['assets', 'list'],
  assets_links: (a) => ['assets', 'links', ...listArgs(a)],
  assets_check: (a) => ['assets', 'check', ...listArgs(a)],
  assets_compliance_check: (a) => ['assets', 'compliance-check', ...listArgs(a)],
  assets_download: (a) => ['assets', 'download', required(a.selector, 'selector'), '-o', required(a.out, 'out'), ...flag('--kind', a.kind)],
  assets_upload: (a) => [
    'assets',
    'upload',
    required(a.selector, 'selector'),
    ...flag('--project', a.project),
    ...flag('--file-uuid', a.file),
    ...flag('--node', a.node),
    ...flag('--asset-type', a.asset_type),
    ...flag('--as-node', a.as_node),
    ...flag('--x', a.x),
    ...flag('--y', a.y),
    ...planOnly(a),
  ],
  assets_oss_authorize: (a) => ['assets', 'oss-authorize', ...planOnly(a)],
  assets_oss_check: (a) => ['assets', 'oss-check', ...planOnly(a)],
  group_list: () => ['group', 'list'],
  group_bind: (a) => ['group', 'bind', required(a.selector, 'selector'), ...flags('--node', a.left)],
  group_use: (a) => ['group', 'use', required(a.selector, 'selector')],
  group_unuse: () => ['group', 'unuse'],
  group_delete: (a) => ['group', 'delete', required(a.selector, 'selector')],
  tasks_list: () => ['tasks', 'list'],
  tasks_quick_list: () => ['tasks', 'quick-list'],
  tasks_history: () => ['tasks', 'history'],
  tasks_detail: (a) => ['tasks', 'detail', required(a.selector, 'selector')],
  tasks_progress: (a) => ['tasks', 'progress', ...listArgs(a)],
  tasks_wait: (a) => ['tasks', 'wait', ...listArgs(a), ...flag('--interval', a.interval), ...flag('--timeout', a.cli_timeout)],
  tasks_cancel: (a) => ['tasks', 'cancel', required(a.selector, 'selector')],
  templates_list: () => ['templates', 'list'],
  templates_get: (a) => ['templates', 'get', required(a.selector, 'selector')],
  templates_categories: () => ['templates', 'categories'],
  templates_storyboard_config: () => ['templates', 'storyboard-config'],
  workflow_list: () => ['workflow', 'list'],
  workflow_show: (a) => ['workflow', 'show', required(a.selector, 'selector')],
  workflow_save: (a) => ['workflow', 'save', required(a.selector, 'selector'), ...flags('-s', a.set)],
  workflow_delete: (a) => ['workflow', 'delete', required(a.selector, 'selector')],
  workflow_run: (a) => ['workflow', 'run', required(a.selector, 'selector'), ...flags('-s', a.set), ...planOnly(a)],
  skill_show: () => ['skill', 'show'],
  skill_files: () => ['skill', 'files'],
  skill_prompt: () => ['skill', 'prompt'],
  skill_package: (a) => ['skill', 'package', ...flag('--out', a.out)],
  update_status: () => ['update', 'status'],
  update_retry: () => ['update', 'retry'],
  update_repair: () => ['update', 'repair'],
  raw_get: (a) => ['raw', 'get', required(a.selector, 'selector'), ...flag('--data', a.data)],
}

function flag(name, value) {
  if (value === undefined || value === null || value === '') return []
  return [name, String(value)]
}

function flags(name, values) {
  if (!Array.isArray(values)) return []
  const out = []
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    out.push(name, String(value))
  }
  return out
}

function listArgs(a) {
  if (Array.isArray(a.items) && a.items.length > 0) return a.items.map(String)
  if (typeof a.selector === 'string' && a.selector.trim()) return [a.selector.trim()]
  throw new Error('action 需要 items（字符串数组）或 selector')
}

function selectorFlag(a) {
  return a.selector ? [a.selector] : []
}

/** `--dry-run` is the default for planning actions; nothing else is added. */
function planOnly(a) {
  return a.dry_run === false ? [] : ['--dry-run']
}

/**
 * Validate argv. Throws a readable error instead of running something that
 * could spend credits, log in interactively, or override the plugin's own
 * Pixmax session.
 */
export function guardArgv(argv) {
  const tokens = argv.filter((token) => !(typeof token === 'string' && token.trim() === '')).map((token) => String(token))
  if (tokens[0] === 'pixmax') tokens.shift()
  const root = tokens[0]
  if (!root) throw new Error('缺少子命令')
  if (root === 'repl') throw new Error('repl 是交互式命令，无法在工具里运行')
  if (!ROOTS.has(root)) throw new Error(`不允许的 pixmax 子命令: ${root}`)
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (SUBMIT_FLAGS.has(lower)) {
      throw new Error(`该参数会提交生成任务并消耗积分，已被工具拦截: ${token}。节点可以创建/修改，提交请到 Pixmax 界面手动执行。`)
    }
    if (FORBIDDEN_FLAGS.has(lower)) throw new Error(`该参数由插件管理，不能透传: ${token}`)
  }
  const dryRun = tokens.includes('--dry-run')
  const path = tokens.filter((token) => !token.startsWith('-'))
  for (const blocked of SUBMIT_PATHS) {
    if (blocked.every((segment, index) => path[index] === segment)) {
      throw new Error(`${blocked.join(' ')} 会直接提交任务并消耗积分，工具不提供；用 --dry-run 的等价命令规划后再到 Pixmax 手动提交。`)
    }
  }
  for (const staged of DRY_RUN_ONLY) {
    if (staged.every((segment, index) => path[index] === segment) && !dryRun) {
      throw new Error(`${staged.join(' ')} 会提交任务并消耗积分；本工具只允许带 --dry-run 的规划调用。`)
    }
  }
  if (root === 'raw' && String(path[1] || '').toLowerCase() !== 'get') {
    throw new Error('raw 只允许 GET；写操作请用有白名单语义的 node/canvas 命令')
  }
  return tokens
}

async function runPixmax(ctx, config, argv, timeoutSec) {
  const tokens = guardArgv(argv)
  const resolved = resolvePixmax(config)
  const secret = await resolveSecret(ctx, 'pixmax')
  const env = {
    ...process.env,
    PIXMAX_CLI_HOME: resolved.home,
    PYTHONUTF8: '1',
  }
  if (resolved.environment) env.PIXMAX_ENV = resolved.environment
  if (secret.value) env.PIXMAX_BEARER_TOKEN = secret.value

  const fullArgs = ['--json', ...tokens]
  let command
  let commandArgs
  if (resolved.entry && existsSync(resolved.entry) && existsSync(resolved.python)) {
    command = resolved.python
    commandArgs = [resolved.entry, ...fullArgs]
  } else {
    const launcher = resolved.launcherPath || (process.platform === 'win32' ? 'pixmax.cmd' : 'pixmax')
    command = process.env.ComSpec || 'cmd.exe'
    commandArgs = ['/d', '/s', '/c', `${quoteArg(launcher)} ${fullArgs.map(quoteArg).join(' ')}`]
  }
  const timeoutMs = Math.max(10, Math.min(600, Number(timeoutSec || config.timeoutSec || 120))) * 1000
  const started = Date.now()
  const result = await runCommand({ command, args: commandArgs, cwd: resolved.home, env, timeoutMs })
  const data = parseJson(result.stdout)
  const ok = !result.timedOut && result.code === 0 && data?.ok !== false
  return {
    argv: tokens,
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
      '调用 Pixmax CLI 的**全部不消耗积分操作**：读取（doctor/登录/项目/画布/节点/模型/任务/模板/工作流/skill）与免费写入（节点 create/update/delete/batch、canvas 原生增删改、资产上传下载/合规、项目文件增删改移、script/storyboard 节点创建）。' +
      '两种用法：① action 简写（doctor | session_status | auth_whoami | auth_credit | project_list | project_files | canvas_get | canvas_summary | canvas_nodes | node_get | node_list | node_create | node_update | node_delete | node_batch | model_search | model_get | image_generate | video_image_to_video | storyboard_create | script_create | script_rows | tasks_list | tasks_wait | assets_upload | assets_download | templates_list | workflow_list | group_list | update_status …）；' +
      '② command 数组直接给 argv，例如 ["node","create","EP2-1组","--type","GENERATE_VIDEO"]。' +
      '工具会拦截一切提交型参数（--run/--submit/--execute/--live）、裸提交命令（tasks submit-batch 等）与非 GET 的 raw；创建/修改节点、规划类命令默认带 --dry-run（dry_run=false 才是真正的免费写入）。' +
      '需要 selector/items/prompt 的 action 会明确报错；命令固定加 --json。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: str('action 简写（见工具描述）；与 command 二选一'),
        command: strList('直接给 pixmax 的 argv，例如 ["node","get","EP2-1组"]；不含 pixmax 本身与 --json'),
        selector: str('节点/模型/任务/模板/工作流/资产的 label、uuid 或 nodeKey；部分命令作为位置参数'),
        items: strList('需要多个位置参数的命令（tasks wait/progress、assets links/check/compliance-check）'),
        command_name: str('canvas_node 的子命令：create | update | delete | restore'),
        query: str('model_search 的搜索词'),
        type: str('model_search 的节点类型（默认 GENERATE_IMAGE）或 project_file_create 的类型'),
        prompt: str('node_create / image / video / storyboard / script 的提示词'),
        model: str('模型 code（如 GPT_IMAGE_2、PIXDANCE_2）'),
        resolution: str('分辨率（如 2K / 480P / 720P）'),
        aspect_ratio: str('画幅比例（如 9:16 / 16:9）'),
        duration: str('视频时长秒数'),
        count: str('生成数量（只是参数，不会提交）'),
        grid: str('storyboard 网格，如 2x2 / 3x3'),
        text: str('script_create 的脚本文本'),
        rows: strList('script_set_rows 的行数据（可重复）'),
        set: strList('额外模型参数 key=value（可重复，映射 -s）'),
        update: strList('metadata data key=value（可重复，映射 -u）'),
        left: strList('上游节点（可重复，映射 --left）'),
        left_add: strList('追加上游节点（映射 --left-add）'),
        left_set: strList('整体替换上游节点（映射 --left-set，按顺序）'),
        left_rm: strList('移除上游节点（映射 --left-rm）'),
        left_clear: bool('清空全部上游节点'),
        data: str('node_batch / canvas_batch 的 JSON 载荷（create/update/delete 数组）'),
        plan_file: str('node_batch 的 --plan-file（JSON 文件路径）；canvas_batch 里映射成 --file'),
        file: str('画布文件 UUID'),
        project: str('项目 UUID'),
        node: str('画布节点 UUID'),
        image_node: str('参考图节点 UUID 或精确 label'),
        name: str('项目文件/目录名'),
        parent: str('项目文件移动的目标目录'),
        group: str('本地节点组名'),
        out: str('输出路径（assets_download / canvas_export / skill_package）'),
        asset_type: str('资产类型（IMG/VIDEO/AUDIO，默认 IMG）'),
        as_node: str('上传后创建 BASE_* 节点的显示名'),
        kind: str('assets_download 的 kind：web | preview | thumbnail'),
        interval: str('轮询间隔秒数'),
        cli_timeout: str('CLI 内部超时（tasks wait 的 --timeout），与工具自身超时无关'),
        online: bool('doctor 是否调用 /user/info 验证 token（仍然只读）'),
        generated: bool('canvas_nodes / node_list 只看已生成节点'),
        include_audio: bool('视频是否带音频参数（不会提交）'),
        dry_run: bool('规划类命令是否带 --dry-run（默认 true；false = 真正执行免费写入）'),
        x: num('画布 X'),
        y: num('画布 Y'),
        timeout: num('命令超时秒数（默认 120，最大 600）'),
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          action: { type: 'string' },
          argv: { type: 'array', items: { type: 'string' } },
          ok: { type: 'boolean' },
          exitCode: { type: 'number' },
          timedOut: { type: 'boolean' },
          ms: { type: 'number' },
          source: { type: 'string' },
          json: { type: 'string' },
          text: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['status', 'ok'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `pixmax ${(value.argv || []).join(' ') || value.action || ''}: ${value.ok ? 'ok' : 'failed'}${value.timedOut ? ' (timeout)' : ''} (${value.ms}ms, ${value.source})`,
            value.json ? value.json.slice(0, 12000) : value.text,
            value.stderr ? `[stderr]\n${value.stderr}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      let action = String(args.action || '')
      let argv
      try {
        if (Array.isArray(args.command) && args.command.length > 0) {
          argv = args.command
        } else if (action) {
          if (action === 'canvas_node') {
            const normalized = { ...args, command: args.command_name || args.command_name }
            argv = ACTIONS.canvas_node(normalized)
          } else {
            const build = ACTIONS[action]
            if (!build) throw new Error(`不支持的 action: ${action}`)
            argv = build(args)
          }
        } else {
          throw new Error('需要 action 或 command 之一')
        }
        const result = await runPixmax(ctx, config, argv, args.timeout)
        return { status: result.ok ? 'completed' : 'failed', action, ...result }
      } catch (error) {
        return {
          status: 'failed',
          action: action || 'command',
          argv: Array.isArray(argv) ? argv.map(String) : [],
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

  ctx.logger?.info?.(`[dsh-shotflow-pixmax] credit-free pixmax tool registered (home ${resolvePixmax(config).home})`)
}
