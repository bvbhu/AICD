# 项目交接文档 — dsh-pixmax-workflow

> 更新时间：2026-11-11 21:20 CST
> 仓库：`D:\projects\dsh-pixmax-workflow`（git repo）
> 远程：`origin → https://github.com/bvbhu/dsh-pixmax-workflow.git`（原 `bvbhu/dsh-shotflow` 已改名，旧地址自动重定向）
> 分支：main（默认），已推送并跟踪 `origin/main`；最新提交见 `git log -1`
> desktop：已通过 `dsh plugin --profile desktop add github:bvbhu/dsh-pixmax-workflow` 安装 v0.3.0；改动后需重新拉取并重启 DSH

---

## 一、定位与组成

DSH 插件 bundle（从 GitHub 安装，未发布 npm），为 AI 视频生成工作流提供 7 个工具、一个只装工具的预设、一个设置页。

**bundle 主行**（`name: 'dsh-pixmax-workflow'`，默认开）**不是子组件**：它加载 `package.json` 的 `main`（`src/settings-host.mjs`），注册设置页 HTTP 桥，且 DSH 只把浏览器端（client 卡片）挂在「说明符恰为包名」的那一行上。关掉它会同时失去设置页与桥。

四个**可独立开关**的条目：

| 条目 | 默认 | 内容 |
| --- | --- | --- |
| `image-tools` | 关 | `model_list`、`image_generation` |
| `video-tools` | 关 | `video_probe`、`video_frames`、`video_scenes`、`video_sheet` |
| `pixmax-tools` | 关 | `pixmax`（81 个 action + `command` 直通 + `skill_install`） |
| `preset-ai-video-workflow` | 开 | 「AI 视频工作流」预设，只组合工具，无 persona、不绑平台、不依赖技能文件 |

预设声明放在 `presets/ai-video-workflow.patch.yml`，与 `cordis.patch.yml` 一起列在 `package.json → dsh.bundle.patch` 数组里（DSH 官方 `@deepseek-ai/dsh-web-app` 同款布局，一个预设一个 patch 文件）。预设自带已启用的工具副本，与根级工具行开关互不影响。

`dsh-pixmax-workflow/settings` 这个 export 仍保留（向后兼容），但**不再作为插件行出现**——既不在根级，也不在预设的 `plugins` 里。

---

## 二、真机问题与修复（2026-11-11 晚）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| `pixmax-tools` 异常：`Cannot read properties of null (reading 'pixmaxHome')` | `cordis.patch.yml` 里 `config:` 后面只有注释，YAML 解析为 `null`；Cordis 把 `null` 直接传给 `apply(ctx, config = {})`，默认参数不生效 | 所有 `apply` 开头加 `config = config \|\| {}`（`image-tools` / `video-tools` / `settings-host` / `pixmax-tools`），`resolvePixmax` / `cliState` 同样兜底；patch 里每行都写显式映射（`config: {}` 或具体字段），YAML 解析已验证无 `config: null` |
| 看不到设置页 | DSH 的 `dsh-client-modules` 只把包的浏览器半侧挂在「name 恰等于包名」的行上；原 patch 里所有行都是 `包名/子路径` 或内置包名，client 从未挂载 | 新增 bundle 主行 `name: 'dsh-pixmax-workflow'`，并把 `package.json` 的 `main` 指向 `src/settings-host.mjs`；client 注册 `plugins.bundle.config`（key = 包名）与两个 `plugins.row.config`（`#image-tools`、`#pixmax-tools`） |
| 看不到 Agent 预设定义 | 预设声明混在主 patch 的第二个 `- insert:` 块里；DSH 官方约定每个预设一个独立 patch 文件并在 `dsh.bundle.patch` 数组列出；此外 `pixmax-tools` 行启动失败也会影响 bundle 状态 | 拆出 `presets/ai-video-workflow.patch.yml`（单个 `- insert:`），`dsh.bundle.patch` 改为数组；预设内移除 `pixmax-workflow-settings` 子行；预设引用的 15 个内置包均已核对存在 |
| pixmax 路径无法在插件页配置 | 原先只能手写 `cordis.patch.yml` 的 `config.pixmaxHome` | 设置页卡片新增「Pixmax CLI 路径」区（主目录 + `PIXMAX_ENV`），通过新增的 `/cli` / `/cli/set` 端点读写 `<root>/pixmax-cli.json`；`pixmax-tools` 行也有独立配置入口，并保留 `config.pixmaxHome` 覆盖 |
| 配置缺失/错误在加载期就报错 | 注册期日志会调 `resolvePixmax(config)` | 注册期完全不碰配置；CLI 检测（`cliState` / spawn 失败）只在 `runPixmax` 调用时执行，错误里附「安装 → 登录 → 环境变量 → 验证」引导，并提示可在设置页改路径 |

---

## 三、目录

```
D:\projects\dsh-pixmax-workflow\
├─ package.json          # main → src/settings-host.mjs；dsh.bundle.patch 为数组
├─ cordis.patch.yml      # bundle 主行 + 三个可独立开关的工具行（默认关）
├─ presets/
│  └─ ai-video-workflow.patch.yml   # 预设声明（单独 patch 文件）
├─ client/
│  └─ pixmax-workflow-settings.js  # 设置卡片（生图模型 + Pixmax CLI 路径），无构建
├─ locale/ icon.svg
├─ src/
│  ├─ settings-host.mjs      # 主行：6 个 HTTP 端点
│  ├─ pixmax-config.mjs      # <root>/pixmax-cli.json 读写（本次新增）
│  ├─ image-tools.mjs / image-models.mjs / image-api.mjs / sensenova.mjs
│  ├─ video-tools.mjs / ffmpeg.mjs / video-frames.mjs
│  ├─ pixmax-tools.mjs       # pixmax 工具 + guard + 报错引导
│  ├─ credentials.mjs / bridge.mjs / chatgpt.mjs / job-runner.mjs / store.mjs
└─ .state/tmp/smoke.mjs     # 85 项自动检查（gitignore，不入 git）
```

`skills/`、`__*`、`.state/`、`conversations/`、`images/`、`video-frames/` 均为 gitignore 的私有材料。

---

## 四、配置与设置页

**设置 → 插件 → dsh-pixmax-workflow**（bundle 配置区）；`image-tools`、`pixmax-tools` 行各有自己的配置入口。

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/dsh-pixmax-workflow/state` | GET | 模型列表、内置模型、key 状态 |
| `/api/dsh-pixmax-workflow/save` | POST | 保存模型列表（校验 id / 去重 / 必填） |
| `/api/dsh-pixmax-workflow/key` | POST | `set` / `clear` / `status` 单个模型的 key |
| `/api/dsh-pixmax-workflow/cli` | GET | CLI 主目录、环境、默认路径、目录是否存在 |
| `/api/dsh-pixmax-workflow/cli/set` | POST | 保存 CLI 主目录与 `PIXMAX_ENV`（只接受 cn/global） |
| `/api/dsh-pixmax-workflow/health` | GET | 健康检查 |

仅同源请求接受（跨站 403、错误方法 405）。模型列表存 `<root>/settings.json`，key 存 DSH 凭据中心（`PIXMAX_WORKFLOW_IMAGE_*`），CLI 配置存 `<root>/pixmax-cli.json`。页面只显示「是否配置 + 来源」，永不显示值。

**CLI 路径优先级**：行 `config.pixmaxHome` > 设置页 `<root>/pixmax-cli.json` > 默认 `~/.pixmax-cli`；环境同理（`config.environment` > 文件 > 空）。

---

## 五、工具与约束

| 工具 | 要点 |
| --- | --- |
| `model_list` | 默认模型 + 每个 model 的 id / 端点 / key 状态 |
| `image_generation` | `prompt` 必填；`browser/*` 走 ChatGPT 网页，其他走 OpenAI Images 兼容端点；`background: true` 走 `ctx.jobs` |
| `video_probe` / `video_frames` / `video_scenes` / `video_sheet` | 主后端 ffmpeg，无 ffmpeg 时探测/截帧回退 Chrome；帧与总览图附加到会话 |
| `pixmax` | `action` 简写（81 个）或 `command` 数组直通；固定加 `--json` |

**硬拦截**：`--run/--submit/--execute/--live`、裸提交命令（`tasks submit-batch`、`group run`）、非 GET 的 `raw`、`repl`；`video generate-final` 只允许带 `--dry-run`；创建/修改类默认 `--dry-run`。

**面向模型的报错引导**（`src/pixmax-tools.mjs`）：`UsageError` / `CliMissingError` 分类，`execute` 的 catch 按类型挂 `hint`，`output.schema` 有 `hint` 字段，`render` 显示 `[操作引导]`。参数错误提示查阅 `pixmax-cli` 技能；CLI 缺失给出安装、登录、环境变量、验证四步。

`skill_install` 把 CLI 自带的 SKILL.md + references 复制进 `~/.dsh/skills/pixmax-cli/`，装完需重启 DSH。

---

## 六、安装与升级

```powershell
dsh plugin --profile desktop add github:bvbhu/dsh-pixmax-workflow
# 首次安装会自动把 "dsh-pixmax-workflow" 加进 desktop/package.json 的 dsh.profile.bundles
# 升级已有安装：dsh plugin --profile desktop update dsh-pixmax-workflow
# 重启 DSH 后生效
```

本地开发可 `dsh plugin --profile <profile> add link:D:/projects/dsh-pixmax-workflow`。

desktop profile 的 `cordis.patch.yml` 里已有 `- id: pixmax-tools / video-tools / image-tools disabled: false`（手动启用过三个工具行）；这些覆盖行不带 `config`，不影响设置页写的 CLI 路径。

---

## 七、验证状态

| 检查项 | 结果 |
| --- | --- |
| `node --check`（src + client 全部） | ✅ 0 失败 |
| `.state/tmp/smoke.mjs` | ✅ **85/85** |
| 两个 patch 文件 YAML 解析 | ✅ 无 `config: null`；预设 15 个 plugins，无 settings 子行 |
| preset 引用的内置包 | ✅ 全部存在于 DSH runtime |
| 远程仓库改名 + 推送 | ✅ `bvbhu/dsh-pixmax-workflow`，main 与 origin/main 同步 |
| 从 GitHub 安装到 desktop | ✅ 依赖 + bundles 已登记 |

smoke 覆盖：模型注册表、设置桥（含 `/cli`、`/cli/set`、非法环境 400）、`guardArgv` 9 拒 7 放、`UsageError` 分类、报错引导文案与 render、`apply(ctx, null)` 四个模块不抛错、设置页写入的 CLI 路径能被 `resolvePixmax` 读到、`skill_install` 双分支（本机 CLI 装/没装都通过）、7 个工具注册、client slot key。

---

## 八、已知限制

- 浏览器渠道分钟级延迟，可能被 Cloudflare 拦；所有浏览器调用串行。
- `pixmax` 依赖本机 CLI（不打包、不自动安装）；`tasks_wait` 默认 120s、最大 600s；提交生成仍需到 Pixmax 界面手动点。
- 设置页 key 写入 DSH 凭据中心；同名环境变量存在时拒绝写入。
- **真机端到端仍需复测**：本轮修复的是加载/挂载/配置链路，设置页卡片、预设列表、生图与视频工具在真实 DSH 会话里的表现要重启后由使用者确认。
- 本机 `~/.pixmax-cli` 已装且可 spawn Python；`~/.dsh/skills/` 里目前只有 `qmk-build`，`pixmax-cli` 技能尚未安装。

---

## 九、重启 DSH 后的复测清单

1. 设置 → 插件 → **dsh-pixmax-workflow**：能看到配置卡片（生图模型 + Pixmax CLI 路径）；`pixmax-tools` 行有「配置」入口。
2. 新建会话的预设列表里能看到 **「AI 视频工作流」**；选它后 7 个工具齐全。
3. 在设置页把 CLI 路径改成错误值：插件不报异常，调用 `pixmax action="doctor"` 才返回安装引导；改回后能跑通。
4. `pixmax action="node_get"`（缺 selector）→ 返回「查阅 pixmax-cli 技能」提示。
5. `pixmax action="skill_install"` → `~/.dsh/skills/pixmax-cli/` 落盘，重启后 DSH 能发现技能。
6. 生图（浏览器渠道 + 一个兼容端点）、本地视频 `video_probe` / `video_frames` / `video_sheet`。
7. 分别开关三个工具行与预设，确认互不影响；**不要关主行**。

---

## 十、Git 与远程

- 远程仓库已由 `bvbhu/dsh-shotflow` 改名为 `bvbhu/dsh-pixmax-workflow`，本地 `origin` 同步更新，旧 URL 自动重定向。
- 主要提交：`a93a0e3`（报错引导 + 四条目清单）、`e27e4e8`（交接文档）、本轮修复提交（见 `git log -1`）。
- 另有 `legacy-history` 分支，不含新改动。

---

## 附：关键文件行数

```
src/pixmax-tools.mjs      ~800 行   # 81 action + guard + 报错引导
src/settings-host.mjs     ~230 行   # 6 个 HTTP 端点
src/pixmax-config.mjs      ~65 行   # CLI 配置文件读写
client/pixmax-workflow-settings.js  ~570 行  # 生图模型 + CLI 路径卡片
cordis.patch.yml           ~40 行   # 主行 + 三个工具行
presets/ai-video-workflow.patch.yml ~90 行   # 预设声明
README.md                 ~110 行   # 已大幅精简
```
