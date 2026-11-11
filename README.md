# dsh-pixmax-workflow

DSH 插件 bundle：给 AI 视频生成工作流提供 7 个工具、一个只装工具的预设、一个设置页。未发布 npm，从 GitHub 安装。

## 组成

bundle 主行 `name: 'dsh-pixmax-workflow'`（默认开）**不是子组件**：它注册设置页的 HTTP 桥，而 DSH 只把浏览器端挂在「说明符恰为包名」的那一行上。别关掉它，否则设置页和桥一起消失。

四个**可独立开关**的条目：

| 条目 | 默认 | 内容 |
| --- | --- | --- |
| `image-tools` | 关 | `model_list`、`image_generation` |
| `video-tools` | 关 | `video_probe`、`video_frames`、`video_scenes`、`video_sheet` |
| `pixmax-tools` | 关 | `pixmax`（81 个 action + `command` 直通 + `skill_install`） |
| `preset-ai-video-workflow` | 开 | 「AI 视频工作流」预设：只组合工具，无 persona、不绑平台、不依赖技能文件 |

预设声明单独放在 `presets/ai-video-workflow.patch.yml`，与 `cordis.patch.yml` 一起列在 `package.json → dsh.bundle.patch`（与 DSH 官方 bundle 同款布局）。三个工具行默认关，避免污染其他预设；预设自带已启用的副本，所以开关互不影响。

> `config:` 只写注释会被 YAML 解析成 `null`，Cordis 会把 `null` 传给插件。所有行都写显式映射，代码层也做了兜底。

## 安装

```powershell
dsh plugin --profile desktop add github:bvbhu/dsh-pixmax-workflow
# 重启 DSH
```

`dsh plugin` 会同时登记依赖与 `dsh.profile.bundles`。本地开发可改用 `add link:D:/projects/dsh-pixmax-workflow`。

重启后新建会话选「AI 视频工作流」即可用全部工具；其他预设里默认没有，需要到设置 → 插件里单独打开三个工具行。

## 配置

设置 → 插件 → **dsh-pixmax-workflow**（bundle 配置区），`image-tools` / `pixmax-tools` 行另有各自的配置入口。

- **生图模型**：内置只有 `browser/gpt-image-2`（ChatGPT 网页）。SenseNova 等 OpenAI Images 兼容端点都是用户模型，存在 `<root>/settings.json`，在设置页里增删改；API key 存 DSH 凭据中心（`PIXMAX_WORKFLOW_IMAGE_<PROVIDER>_API_KEY`），页面只显示「是否配置 + 来源」，永不显示值。
- **Pixmax CLI 路径**：填 CLI 主目录与 `PIXMAX_ENV`（cn / global），留空用 `~/.pixmax-cli`。写入 `<root>/pixmax-cli.json`，**调用工具时**才读取；也可以在 `pixmax-tools` 行 config 里直接写 `pixmaxHome`（行配置优先）。
- 路径没配或配错**不会让插件加载失败**，只在调用 `pixmax` 时返回带安装步骤的可读错误。

## 工具速查

| 工具 | 说明 |
| --- | --- |
| `model_list` | 模型列表、默认模型、key 状态 |
| `image_generation` | 生图/改图；`prompt` 必填，不传 `model` 用默认，`background: true` 走后台 job |
| `video_probe` | 时长 / 分辨率 / 帧率 / 编码 |
| `video_frames` | 按间隔、时间点或帧号截帧（默认上限 12 帧；`max_frames` 是上限不是配额） |
| `video_scenes` | ffmpeg 镜头切点，返回 `count` 与时间列表（0 个也会明确报 `切点 0 个`） |
| `video_sheet` | 总览图 |
| `pixmax` | Pixmax CLI 的全部零积分操作 |

```text
pixmax action="node_get" selector="<uuid>"
pixmax command=["node","get","EP2-1组"]
```

**硬拦截**：`--run` / `--submit` / `--execute` / `--live`、裸提交命令（`tasks submit-batch`、`group run`）、非 GET 的 `raw`、`repl` 一律拒绝；`video generate-final` 只允许带 `--dry-run`；创建/修改类默认 `--dry-run`（`dry_run: false` 才是真正的免费写入）。

**报错引导**：参数或用法错误 → 提示查阅 `pixmax-cli` 技能；CLI 未安装 / 无法启动 → 返回「安装 → 登录 → 环境变量 → 验证」完整步骤。提示在返回值的 `hint` 字段，渲染为 `[操作引导]` 段。

**参数保护**：`pixmax node update` 会**整体替换**节点 params——只传 `--prompt` 会把 `model`/`duration`/`resolution` 等全部丢掉（CLI 从空对象重建）。工具在 `node_update` 前先读节点现有 params 并自动回传，只有显式写进 `set` 的键才覆盖；`merge_params: false` 可关闭这层保护。

## Pixmax CLI

本机需自行安装（`~/.pixmax-cli`，插件不打包 CLI）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1   # Windows；macOS/Linux 用 scripts/install.sh
pixmax auth login web          # 或 auth login token <TOKEN> / 环境变量 PIXMAX_BEARER_TOKEN
pixmax action="doctor"         # 自检
pixmax action="skill_install"  # 把 CLI 自带 SKILL.md + references 装进 ~/.dsh/skills/pixmax-cli/
```

`skill_install` 装完重启 DSH，会话里就能看到 `pixmax-cli` 技能。

## 前置条件

- DSH 0.2.2 系列、Node ≥ 20
- 浏览器渠道：已登录 chatgpt.com 的 Chrome + DSH-Browser-Control 扩展/插件（本地桥 `127.0.0.1:9777`）
- 视频工具：ffmpeg（推荐）；没有时 `video_probe` / `video_frames` 回退 Chrome
- `pixmax` 工具：本机装好并登录 Pixmax CLI

## 排错

| 现象 | 处理 |
| --- | --- |
| 插件行报 `Cannot read properties of null` | 已修复：空 `config:` 改为显式映射，所有 `apply` 对 `null` 兜底 |
| 看不到设置页卡片 | 确认主行 `dsh-pixmax-workflow` 已启用并重启 DSH；浏览器端只挂在这一行 |
| 看不到「AI 视频工作流」预设 | 确认 `dsh.bundle.patch` 数组列出了 `presets/ai-video-workflow.patch.yml`，并重启 DSH |
| `pixmax` 报 CLI 未就绪 | 按返回的安装引导操作，或在设置页卡片里填正确的 CLI 主目录 |
| `tasks_wait` 卡住 | 默认 120s，最大 600s；生成提交仍需到 Pixmax 界面手动执行 |

## 开发

```powershell
node --check src/*.mjs
node .state/tmp/smoke.mjs    # 92/92：模型注册表、设置桥（含 CLI 配置）、guard、报错引导、params 合并、工具注册
```

`.state/`、`conversations/`、`images/`、`video-frames/`、`skills/`、`__*` 均为私有工作材料，`.gitignore` 已排除。

> 仅供个人使用。把 ChatGPT 网页版当自动化接口批量调用不符合其服务条款取向，请自行控制频率与风险。
