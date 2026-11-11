# dsh-pixmax-workflow — DSH 插件：AI 视频生成工作流工具

一个 DSH bundle：三个**子组件**各自独立成行、可分别开关，另附一个生图模型设置页与一个**只装工具**的预设。

1. **图像工具**（`image-tools`）— `model_list`（生图模型列表与 key 状态）与 `image_generation`（生图/改图，按 **模型 id** 选渠道）；支持 `background: true` 后台生成，不阻塞对话。
2. **视频解析工具**（`video-tools`）— `video_probe`（时长/分辨率/帧率）、`video_frames`（按间隔/时间点/帧号截帧）、`video_scenes`（镜头切点）、`video_sheet`（总览图）。默认走 ffmpeg，没有 ffmpeg 时探测/截帧回退 Chrome；帧和总览图会作为图片附加到当前会话。
3. **Pixmax 工具**（`pixmax-tools`）— `pixmax` 覆盖 CLI 里**所有不消耗积分的操作**（读取 + 免费写入），并硬性拦截一切提交型参数与裸提交命令；还能把 CLI 自带的 skill 装进 DSH 技能目录。
4. **生图模型设置页**（`pixmax-workflow-settings`，默认启用）— 在 **Settings → 插件 → Pixmax Workflow** 里管理「生图专用模型」：浏览器渠道固定为 `browser/gpt-image-2`，其他 OpenAI 兼容端点按 `provider/modelid` 添加；每个模型的 API key 在这里写入 DSH 凭据中心，**不再有管理密钥的工具**。
5. **「AI 视频工作流」预设** — 只组合上面这些工具与基础文件/命令/任务能力，不带自定义 persona、不绑定任何具体视频生成平台、不依赖任何技能文件。

不绑定固定平台：生成环节用你自己的工具链；dsh-pixmax-workflow 只负责生图与本地视频解析。

> 仅供个人使用。把 ChatGPT 网页版当自动化接口批量调用不符合 OpenAI 的服务条款取向，请自行控制频率与风险。

---

## 组成

| 部分 | 内容 |
| --- | --- |
| 图像工具 | `src/image-tools.mjs` → `model_list` / `image_generation`；浏览器渠道走 `src/chatgpt.mjs`，端点渠道走 `src/image-api.mjs`，模型注册表在 `src/image-models.mjs` |
| 生图模型 | `src/image-models.mjs` 管模型注册表与 `<root>/settings.json`；浏览器渠道走 ChatGPT 网页（`src/chatgpt.mjs`），OpenAI 兼容端点走 `src/image-api.mjs`（JSON data-URL 或 multipart 两种请求体）；`src/sensenova.mjs` 保留为兼容包装 |
| 设置页 | `src/settings-host.mjs` 注册 `/api/dsh-pixmax-workflow/*` 桥（读写模型列表、写入/清除 key），`client/pixmax-workflow-settings.js` 是插件页里的浏览器卡片；密钥解析在 `src/credentials.mjs` |
| 后台任务 | `src/job-runner.mjs` → 把 `background: true` 的生成挂到 DSH `ctx.jobs`，完成后用 `job_output` 取结果 |
| 视频工具 | `src/video-tools.mjs` → `video_probe` / `video_frames` / `video_scenes` / `video_sheet`；`src/ffmpeg.mjs` 是主后端，`src/video-frames.mjs` 是无 ffmpeg 时的 Chrome 回退 |
| Pixmax 工具 | `src/pixmax-tools.mjs` → `pixmax` 零积分操作（读 + 免费写，提交被拦截）；直接调用当前 runtime 的 `entry.py`，绕过启动器更新门禁 |
| 预设 | `cordis.patch.yml` 插入 `@deepseek-ai/dsh-agent-preset`：`id: ai-video-workflow`，`name: AI 视频工作流` |

## 运行时序

```
image_generation (browser/* 模型)
        │  优先复用已打开的 chatgpt.com 标签页；没有才新开
        │  HTTP POST /api/command（Bearer token）
        ▼
@angelky7/dsh-browser-control 桥（127.0.0.1:9777）→ DSH-Browser-Control 扩展 → 已登录 ChatGPT 标签页

image_generation(model=<provider>/<modelid>，OpenAI Images 兼容端点)
        │  POST <baseUrl>/images/{generations|edits}（baseUrl / key 都来自设置页）
        ▼
保存 PNG/JPEG/WebP 到 <root>/images/

pixmax（零积分）
        │  python <pixmaxHome>/runtime/versions/<current>/entry.py --json <command>
        │  提交型参数（--run 等）与裸提交命令在工具内被拦截
        ▼
Pixmax /user/api（读取 + 免费写入：doctor/project/canvas/node/model/task/template/asset/工作流）

设置页（Settings → 插件 → Pixmax Workflow）
        │  fetch /api/dsh-pixmax-workflow/{state,save,key,health}
        ▼
<root>/settings.json（模型列表） + DSH 凭据中心（API key）

video_probe / video_frames / video_scenes / video_sheet
        │  ffmpeg（优先；ffmpegPath 可配置）或 Chrome 回退
        ▼
DSH attachments 服务 → 图片块附加到当前会话
```

回复不是从 DOM 抄的：它读取 `/backend-api/conversation/<id>` 的 `content.parts`，所以 Markdown 表格、代码块、加粗都保真。

## 前置条件

| 组件 | 要求 |
| --- | --- |
| DSH | 0.2.2 系列（本仓库在 `0.2.2-rc.1` 上实测） |
| ffmpeg | **推荐**。视频工具默认找 `ffmpegPath` 配置 → `DSH_FFMPEG_PATH` → PATH → 常见安装目录；没有 ffmpeg 时只有 `video_probe`/`video_frames` 能回退 Chrome |
| Chrome | 116+，且已登录 <https://chatgpt.com>（图像工具的浏览器渠道与视频回退都需要） |
| Chrome 扩展 | **DSH-Browser-Control**（与 `@angelky7/dsh-browser-control` 配套的那个，v1.7.2 实测） |
| DSH 插件 | `@angelky7/dsh-browser-control` 已安装并在设置中启用（默认端口 `9777`、token `dsh-local`） |
| 生图端点（可选） | 用 OpenAI 兼容端点（内置 SenseNova）时，在该模型的设置页里填 key，或设置对应环境变量（环境变量优先） |
| Pixmax CLI（可选） | 只用 `pixmax` 工具时需要本机已安装 `~/.pixmax-cli`；工具直接读当前 runtime，不触发更新门禁 |
| Node | ≥ 20（DSH 自带的 Node 即可） |

`ffmpegPath` 可以指向任意 ffmpeg 构建（共享构建需要同目录 DLL 一起保留）：

```yaml
- id: video-tools
  name: 'dsh-pixmax-workflow/video'
  config:
    ffmpegPath: 'D:/path/to/ffmpeg.exe'
```

不配置也可以：插件会依次尝试 `DSH_FFMPEG_PATH`、PATH、`C:\ffmpeg\bin`、`D:\ffmpeg\bin`、`C:\Program Files\FormatFactory`、`D:\Program Files\FormatFactory`、winget/chocolatey 的常见位置。`ffprobe` 不是必需——没有它时用 `ffmpeg -i` 解析时长/分辨率/帧率。

## 安装

```powershell
dsh plugin --profile <profile> add link:<repo>
# 然后把 "dsh-pixmax-workflow" 加入 dsh.profile.bundles（dsh plugin add 通常会自动加）
# 重启 DSH 后生效
```

桌面版 profile 由 Electron 应用管理；如果 CLI 安装被拒，用 DSH 的插件页/插件管理器安装同一个本地目录或打好的压缩包。

安装后：

- 新建会话时预设列表里出现 **「AI 视频工作流」**；
- 在该预设会话里可以直接调用 `model_list` / `image_generation`、`pixmax` 和 `video_probe` / `video_frames` / `video_scenes` / `video_sheet`；
- 在 **Settings → 插件 → dsh-pixmax-workflow** 里管理生图模型与 API key（根级 `pixmax-workflow-settings` 行默认启用，只注册一个 JSON 桥，不带任何工具）；
- 其他预设（如内置 standard）里**没有**这些工具。

### 其他预设：手动启用工具

三个子组件 `image-tools` / `video-tools` / `pixmax-tools` 在根级各自独立成行、默认关闭，**可以分别单独启用**（在 DSH 的插件/设置界面开关，或写进目标预设的 `plugins` 列表）：

```yaml
- id: image-tools
  name: 'dsh-pixmax-workflow/image'
  config:
    bridgeUrl: 'http://127.0.0.1:9777'   # 可选
    token: 'dsh-local'                   # 可选
    reuseExistingTab: true               # 默认 true：优先复用已打开的 chatgpt.com 标签页
    root: 'D:/path/to/outputs'           # 可选，默认 ~/.dsh/gpt-web
- id: video-tools
  name: 'dsh-pixmax-workflow/video'
  config:
    bridgeUrl: 'http://127.0.0.1:9777'   # 可选
    token: 'dsh-local'                   # 可选
    ffmpegPath: 'D:/path/to/ffmpeg.exe'  # 可选；不填则自动找
    root: 'D:/path/to/outputs'           # 可选，默认 ~/.dsh/gpt-web
- id: pixmax-tools
  name: 'dsh-pixmax-workflow/pixmax'
  config:
    pixmaxHome: 'C:/Users/you/.pixmax-cli'  # 可选
    environment: cn                         # 可选：cn | global
- id: pixmax-workflow-settings
  name: 'dsh-pixmax-workflow/settings'
  config:
    root: 'D:/path/to/outputs'              # 可选：settings.json 跟着图像工具的输出根目录走
```

> DSH 的 preset 覆盖是**整份 `plugins` 列表替换**，不是逐项合并；覆盖内置 preset 时记得把原有条目一起带上。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `image_generation` | `prompt`(必填)、`model`、`ref[]`、`out`、`size`、`format`、`watermark`、`timeout`、`background` | 图片绝对 `path`、`model`、`channel`、宽高（后台模式返回 `job_id`） |
| `model_list` | — | 默认模型 + 每个模型的 id、类型、端点、是否已配 key（不返回值） |
| `pixmax` | `action` 或 `command[]`，以及 `selector`/`items`/`prompt`/`model`/`set[]`/`left_set[]`/`dry_run` 等 | 零积分 JSON 查询与免费写入结果 |
| `video_probe` | `path`(必填) | `duration`、`width` / `height`、`fps`、`codec`、`backend` |
| `video_frames` | `path`(必填)、`every` / `times` / `frames` 三选一、`from`、`to`、`max_frames`、`width`、`quality`、`out`、`attach`、`backend` | 帧文件路径 + 元数据，并把帧附加到当前会话 |
| `video_scenes` | `path`(必填)、`threshold`、`max_scenes`、`from`、`to` | 镜头切点时间列表（ffmpeg） |
| `video_sheet` | `path`(必填)、`fps`、`cover`、`columns`、`rows`、`width`、`out`、`attach` | 一张总览图，并附加到当前会话 |

- `image_generation` 的 `model` 选模型，各模型特点见下文。
- 浏览器渠道**优先复用已打开的 chatgpt.com 标签页**（会在里面点“新聊天”或打开指定会话）；没有可用标签页时才新开一个后台标签页。串行执行：同一时间不要并发调用。

### 生图模型：用 `model` 选模型

`image_generation` 生图、改图都走同一套模型列表。**模型 id 就是 `provider/model`**：

| 模型 | 特点 |
| --- | --- |
| `browser/gpt-image-2`（默认） | ChatGPT 网页版。不需要 API key，用网页额度；支持参考图/编辑；分钟级；依赖 Chrome 登录，可能被 Cloudflare 拦截；固定输出 PNG；有 ChatGPT 会话上下文 |
| 任意 `provider/modelid` | OpenAI Images 兼容端点（内置 `sensenova/sensenova-u1.5-lite` 与 `...-fast`）。需要 key，**按张计费**；同步数秒级；支持 1–5 张参考图编辑；尺寸 512–4096/2K/4K；输出 png/jpeg/webp；无 ChatGPT 对话上下文；稳定、可后台 |

```text
image_generation prompt="雨夜霓虹街道，电影感"
image_generation prompt="把这张图改成水彩" ref=["cat.png"] model="sensenova/sensenova-u1.5-lite" size="2048x2048" format="webp"
model_list                  # 看有哪些模型、默认是哪个、key 配没配
```

- 不传 `model` 就用设置页里的**默认模型**；传 `browser` / `sensenova` 这类别名也会被解析。
- `size` 对浏览器渠道只是写进 prompt 的提示；对端点渠道会映射到接口支持的值（`auto`/`2K`/`4K`/`1:1`/`16:9`/`9:16`/`3:2`/`2:3`，或 512–4096 且为 32 倍数的 `WxH`）。
- `watermark` 默认 `false`（显式传给接口）；`format` 只影响端点渠道。
- 两者都支持 `background: true`。

### 设置页：管理生图模型与 API key

**Settings → 插件 → dsh-pixmax-workflow**（根级 `pixmax-workflow-settings` 行默认启用）里可以做三件事：

1. 看内置模型、启停它们、设为默认；
2. 添加任意 OpenAI 兼容端点：模型 id（`provider/modelid`）、显示名、Base URL、端点模型名、可选环境变量名、请求体格式（JSON data-URL / multipart）；
3. 给每个端点保存或删除 API key —— **页面只显示是否已配置与来源，永远不显示值**。

底层：

- 模型列表存在 `<root>/settings.json`（跟 `gpt` 工具输出根目录同一个 root），**不写 profile 的 `cordis.patch.yml`**，改完即时生效、无需重启；
- API key 写入 **DSH 凭据中心**，同名环境变量优先；环境变量已设置时页面会拒绝写入并说明原因；
- 桥接口只有四个：`GET /api/dsh-pixmax-workflow/state`、`POST /api/dsh-pixmax-workflow/save`、`POST /api/dsh-pixmax-workflow/key`、`GET /api/dsh-pixmax-workflow/health`，且只接受同源请求。

**没有管理密钥的工具**：key 只在设置页配置，工具只读取。

Pixmax 的 Bearer token 仍走 `PIXMAX_BEARER_TOKEN` 环境变量或 Pixmax CLI 自己的登录会话。

### Pixmax：所有不消耗积分的操作

`pixmax` 覆盖 CLI 里**零积分**的完整操作面：读取（doctor / auth / project / canvas / node / model / task / template / workflow / skill）与**免费写入**（节点 create/update/delete/batch、canvas 原生增删改、资产上传下载与合规、项目文件增删改移、script 与 storyboard 节点创建）。

两种用法：

```text
# ① action 简写
pixmax action="doctor"
pixmax action="canvas_summary"
pixmax action="canvas_nodes" generated=true
pixmax action="node_get" selector="<uuid>"
pixmax action="node_update" selector="EP2-1组" name="EP2-1组（改）" left_set=["<uuid>"] dry_run=false
pixmax action="assets_upload" selector="C:/tmp/ref.png" as_node="参考图" dry_run=false
pixmax action="model_search" query="pix" type="GENERATE_IMAGE"
pixmax action="tasks_wait" items=["<node-uuid>"]
pixmax action="templates_list"

# ② 直接给 argv（任何免费操作都能这样调）
pixmax command=["node","create","EP2-1组","--type","GENERATE_VIDEO","--prompt","...","--x","5560","--y","4126"]
```

**硬性拦截**（工具内校验，不是靠人自觉）：

- 任何 `--run` / `--submit` / `--execute` / `--live` 参数 → 直接拒绝并说明“提交会消耗积分，请到 Pixmax 界面手动执行”；
- 裸提交命令：`tasks quick-submit` / `tasks submit-batch` / `tasks template-submit` / `group run`；
- `video generate-final` 只允许带 `--dry-run`；
- `raw` 只允许 GET；`repl` 与 CLI 的 `--token/--session-file/--config-file/--base-url/--environment` 不允许透传。

其他要点：

- 规划类命令（create/update/image/video/storyboard/script/workflow run）默认带 `--dry-run`，只有显式 `dry_run: false` 才真正落盘——落盘也是免费写入，不会提交生成。
- 直接调用 `~/.pixmax-cli/runtime/current.json` 指向的 `entry.py`，绕过启动器的更新门禁（本机曾遇到运行时下载超时导致 `pixmax` 启动失败）。
- 固定 `--json`；超时默认 120s、最大 600s；命令可并发。
- 需要 `selector` / `items` / `prompt` 的 action 会明确报错。
- 如果 CLI 未安装，工具会返回可读错误；README 不打包 CLI。
- `action="skill_install"` 把 CLI 自带的 skill 装进 DSH skills 目录（见下文）。

### Pixmax CLI 的 skill：怎么用上

Pixmax CLI 自带一份 SKILL.md + references（`generation-node-protocol-v1.md`，29 KB，讲清各类生成节点的字段/约束/示例）。工具不会把这份 skill 自动挂进 DSH——DSH 的技能目录是静态的，插件不能在运行时注册新技能。所以提供一条显式命令把它复制进去：

```text
pixmax action="skill_install"                       # 装到 ~/.dsh/skills/pixmax-cli/
pixmax action="skill_install" out="D:/my-skills"    # 装到别的 skills 根目录（自动加 pixmax-cli/ 子目录）
pixmax action="skill_install" name="pixmax-cli" out="D:/proj/.dsh/skills"
```

装好后：

1. 重启 DSH（技能目录在启动时扫描一次）；
2. 会话里应该能看到 `pixmax-cli` 技能，内容就是 CLI 的 SKILL.md；
3. 或者不装 skill、直接用工具：`pixmax action="skill_prompt"` 会把 CLI 自己的使用说明打印出来，`skill_show` 打印命令清单，`skill_files` 列出原始文件，`skill_package` 把完整 skill 打包成 zip。

**skill 目录结构**（复制进 `<skills 根>/pixmax-cli/`）：

| 文件 | 来源（CLI 安装目录相对路径） |
| --- | --- |
| `SKILL.md` | `pixmax/skills/SKILL.md`（frontmatter `name: pixmax-cli`） |
| `references/generation-node-protocol-v1.md` | `pixmax/skills/references/` |
| `README.md` | `pixmax/README.md` |
| `PIXMAX.md` | `PIXMAX.md` |

- 复制是幂等的，重复装会覆盖旧文件；想换名字就传 `name`（需与 SKILL.md frontmatter 一致，否则 DSH 用目录名）。
- 复制源是 `pixmax action="skill_files"` 返回的 `root`；CLI 升级后（`update_status` 显示版本变化）重新 `skill_install` 一次即可同步新版 skill。
- 写不进目标目录时会报 `${targetDir}（权限/路径不存在）`，换 `out` 指到有写权限的地方。

### Pixmax CLI 安装与配置

工具依赖本机已装好的 Pixmax CLI（`~/.pixmax-cli`，含 launcher / runtime / config.json）。**插件和本 README 不打包、不自动安装 CLI**，需要先手动装：

1. 拿到 CLI 包（Pixmax 官方渠道提供的 zip / 安装器）；
2. 运行包里的安装脚本：
   - Windows：`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`；
   - macOS / Linux：`bash scripts/install.sh`；
3. 默认装到 `~/.pixmax-cli`；想换位置设环境变量 `PIXMAX_CLI_HOME`，工具会尊重它（配置里 `pixmaxHome` 也行）；
4. 安装器写好 `launcher-config.json`（含 `installedPython`、channel、manifest URL、公钥）；runtime 版本目录在 `~/.pixmax-cli/runtime/versions/<id>`，`runtime/current.json` 指向当前版本。

**登录**（三选一）：

- 浏览器登录：`pixmax auth login web`（打开网页授权，token 落在 `config.json`）；
- token 登录：`pixmax auth login token <TOKEN>`；
- 环境变量：`PIXMAX_BEARER_TOKEN`（优先级最高，工具与 CLI 都认它）。

**环境**：`PIXMAX_ENV=cn` 或 `global`（默认 cn）。工具配置里 `environment` 也能覆盖。

**验证**：

```text
pixmax action="doctor"                  # 本地自检：CLI 版本 / Python / 登录状态
pixmax action="doctor" online=true      # 联网校验 token（消耗一次 API 调用，不花积分）
pixmax action="auth_whoami"             # 当前账号
pixmax action="auth_credit"             # 剩余额度
pixmax action="update_status"           # CLI 是否有更新
```

**常见问题**：

- **启动器卡在“Runtime 下载/自更新”**：工具已经绕过——直接调 `runtime/current.json` 指向的 `entry.py`，不走启动器门禁。想手动修就用 `pixmax action="update_status"` / `update_retry` / `update_repair`。
- **CLI 没装 / 路径不对**：工具返回可读错误；检查 `PIXMAX_CLI_HOME` 或配置里的 `pixmaxHome`。
- **Python 不是 3.x**：安装器通常已经选好；手动装时确认 `installedPython` 指向 Python 3.10+。
- **token 失效**：重新 `auth login` 或更新 `PIXMAX_BEARER_TOKEN`；工具不缓存 token，每次调用都现场读。

### 异步调用：`background: true`

`image_generation` 支持后台执行。生成期间不再占住当前对话轮次：

```text
image_generation  prompt="雨夜霓虹街道" background=true
→ { status: "running", job_id: "gpt-1a2b3c4d5e6f7890" }

（继续聊别的事）

job_output job_id="gpt-1a2b3c4d5e6f7890"
→ [gpt] 完成
  {"status":"completed","conversation_id":"...","path":"...","url":"...","title":"...","text":"...","text_truncated":false}
```

- 工具立即返回 `job_id`，真正的生成在 DSH 后台任务里跑；完成后 `@deepseek-ai/dsh-tool-jobs` 会**在会话内发完成通知**，不用轮询。
- 结果用 `job_output` 读；不要了就 `job_kill`。取消会关掉对应的 ChatGPT 标签页。
- 后台任务依赖 `ctx.jobs` 与 `dsh-tool-jobs` 控制器：本插件的预设已内置 `tool-jobs`；如果某个预设没有它，`background: true` 会明确报“没有可用的后台任务服务”。
- 任务只存在于 DSH 进程内：DSH 重启会丢失运行中的任务（已完成写入的 Markdown/图片仍在磁盘）。
- `prompt`/`file`/`conversation` 的校验在启动 job 前完成，参数错误会直接同步报错，不会留下空任务。
- 图片后台结果里带绝对 `path`；Markdown 后台结果里带 `path` 和最多 3KB 的正文预览（全文看文件）。

### 视频解析：ffmpeg 优先，Chrome 回退

默认后端是 ffmpeg（`backend: auto`）。只要 `ffmpegPath`、`DSH_FFMPEG_PATH` 或 PATH/常见目录里找到 ffmpeg 就用 ffmpeg；完全没有时才让 `video_probe` / `video_frames` 回退到 Chrome 回环解码。

#### `video_frames`

```text
path       视频路径
every      按间隔截帧，单位秒（与 times / frames 三选一）
times      指定时间点数组，如 ["3", "00:12", "1:02:03"]
frames     指定帧号数组，如 [96, 120]（仅 ffmpeg；适合和切点对齐）
from/to    间隔模式的起止时间（默认 0 → 视频结尾）
max_frames 最多截几帧，默认 12、上限 16；超出时按时间均匀抽样
width      帧最大宽度，默认 1280（只缩小不放大）
quality    JPEG 质量（Chrome 回退用；ffmpeg 统一 q:v 2）
out        输出目录；默认 <root>/video-frames/<视频名>-<时间>/
attach     是否把帧附加到当前会话，默认 true
backend    auto（默认）| ffmpeg | chrome
```

#### `video_scenes`

```text
path       视频路径
threshold  场景变化阈值，默认 0.25；画面变化大用 0.2，变化小用 0.3–0.4
max_scenes 最多返回多少个切点，默认 30
from/to    检测区间（可选）
```

实现是单遍 `select='gt(scene,0.25)',showinfo`，从 stderr 的 `pts_time` 取切点。拿到时间后再用 `video_frames times=[...]` 精确取证。

#### `video_sheet`

```text
path       视频路径
fps        采样密度；不填时按 cover 自动覆盖整段
cover      默认 true：fps = (columns*rows)/duration，让总览图均匀覆盖整段视频
columns    列数，默认 4
rows       行数，默认 3
width      每格宽度，默认 496
out        输出路径；默认 <root>/video-frames/<视频名>-sheet-<时间>.jpg
```

一张总览图只占一个图片块，比逐帧附加省 token，适合先看整体再定点抽帧。

#### 实测（10s / 1920×1080 / 30fps，输出 1280×720 JPEG）

| 操作 | ffmpeg | Chrome 回退 |
| --- | --- | --- |
| `video_probe` | ~80 ms | ~145 ms |
| 8 帧（每帧间隔） | **249 ms** | 1454 ms |
| 3 个指定时间点 | 564 ms | 逐帧 seek，需前台 |
| 按帧号 `[0,30,60]` | 260 ms | 不支持 |
| 4×3 总览图 | 206 ms | 不支持 |
| 后台/无人值守 | 可以 | 必须保持标签页激活、窗口可见 |

- ffmpeg 的间隔模式是**单遍 `fps` 滤镜**；超过 `max_frames` 时自动把采样间隔拉大、均匀覆盖整个区间。
- 时间点模式对每个时间点跑一次 `-ss` 精确 seek；帧号模式用 `select='eq(n,N)'`。
- 截帧不需要 Python；`ffprobe` 也不是必需。
- 帧/总览图会以图片块进入当前会话，**会话模型必须声明 image 输入**；否则只保存到磁盘并在结果里说明原因。
- 没有 ffmpeg 时的 Chrome 回退：本地回环 HTTP + 标签页解码，Chrome 会冻结后台标签页，所以截帧期间标签页保持激活；这条路径只适合临时应急。


## 目录

```
.
├─ package.json          # dsh-pixmax-workflow bundle + dsh.client（插件页卡片）
├─ cordis.patch.yml      # 根级 image-tools / video-tools / pixmax-tools（默认关，独立开关）+ pixmax-workflow-settings（默认开）+ 预设
├─ client/
│  └─ pixmax-workflow-settings.js  # 插件页里的生图模型设置卡片（无需构建）
├─ locale/               # en/zh.json：插件名与描述
├─ icon.svg              # 插件图标
├─ src/
│  ├─ image-tools.mjs    # model_list / image_generation
│  ├─ image-models.mjs   # 生图模型注册表 + <root>/settings.json
│  ├─ image-api.mjs      # OpenAI Images 兼容端点（JSON data-URL / multipart）
│  ├─ settings-host.mjs  # 设置页的 Host 桥（/api/dsh-pixmax-workflow/*）
│  ├─ sensenova.mjs      # SenseNova 兼容包装（复用 image-api）
│  ├─ credentials.mjs    # 环境变量优先 / DSH 凭据中心兜底（含按模型取 key）
│  ├─ video-tools.mjs    # 视频工具注册
│  ├─ ffmpeg.mjs         # ffmpeg 后端：探测/截帧/切点/拼图
│  ├─ pixmax-tools.mjs   # Pixmax 零积分工具（直接调 runtime entry.py）
│  ├─ bridge.mjs         # DSH Browser Control HTTP 客户端
│  ├─ chatgpt.mjs        # 网页驱动：ask / 续聊 / 生图 / 标签页复用
│  ├─ job-runner.mjs     # background=true 的 DSH 后台 job 包装
│  ├─ video-frames.mjs   # 无 ffmpeg 时的回环 HTTP + Chrome 解码 + canvas 截帧
│  └─ store.mjs          # 路径、Markdown、last.json
├─ conversations/        # 运行产物（gitignore）
├─ images/               # 运行产物（gitignore）
├─ video-frames/         # 截帧产物（gitignore）
└─ .state/               # 运行状态（gitignore）
```

## 设计取舍

- 网页驱动走 **DSH-Browser-Control 扩展 + 桥接**，优先复用已打开的 chatgpt.com 标签页，避免新标签页被 Cloudflare 拦截；所有浏览器驱动的调用串行。
- 生图按**模型 id** 分派：`browser/*` 复用网页登录态，其他 `provider/modelid` 走 OpenAI 兼容端点，两者复用同一套 `background` / 保存 / 附加逻辑。
- 模型列表与 key 分开存放：模型是用户数据（`<root>/settings.json`），key 是秘密（DSH 凭据中心）；插件不把 key 写进配置、不通过工具暴露 key。
- 视频主后端是 **ffmpeg**：单遍滤镜、精确 seek、切点与总览图都更准更快；Chrome 回退只用于没有 ffmpeg 的应急场景。
- Pixmax 暴露**所有零积分操作**（读 + 免费写），但把“提交生成”做成硬拦截：`--run` 类参数与裸提交命令在工具内被拒绝，规划类命令默认 `--dry-run`。
- 预设**只组合工具**：没有自定义 persona，不引用任何技能文件，也不绑定某个视频生成平台；生成环节由使用者自己的工具链完成。
- 后台任务走 DSH `ctx.jobs`：结果与完成通知由 DSH 统一管理，插件不自己维护轮询进程。

## 已知限制

- 同一扩展桥接一次只能串行驱动一个页面动作；浏览器渠道在进程内串行执行。
- gpt 默认复用已打开的 chatgpt.com 标签页：会在该标签页里点“新聊天”或打开指定会话，可能改变你当前的页面；没有找到标签页时才新开。
- Free 套餐有生图额度；额度用尽会明确报错，不会静默挂起或保存错图。
- 端点渠道会按张计费；内置 SenseNova 模型需要 key（环境变量 `SENSENOVA_API_KEY` 或设置页）；`watermark` 默认显式传 `false`；输出尺寸受 512–4096、32 倍数、3:1 比例限制时按接口规则映射，超界会在本地报错。
- 设置页写入的是 DSH 凭据中心；同名环境变量存在时拒绝写入。页面只显示是否配置与来源，永远不返回值。
- 模型 id 必须是 `provider/model`：内置 `browser/gpt-image-2` 的 provider 固定为 `browser`；新端点不能与内置模型同名。
- 面板窗口的「锁定」、只读/禁脚本策略由浏览器扩展控制；被拦住时命令会带可读错误返回。
- 网页改版可能让选择器失效；`src/chatgpt.mjs` 里的 composer / send 选择器集中在一处，便于修。
- 视频主后端是 ffmpeg：`ffmpegPath` 指向不存在的文件会明确报错；共享构建需要同目录 DLL 一起保留（spawn 时会把工作目录设为 ffmpeg 所在目录）。
- `video_scenes` 只检测高于 `threshold` 的硬切；渐变/溶解转场可能漏检，阈值要按素材微调。
- `video_sheet` 显式给 `fps` 时只取前 `columns*rows` 个采样帧（适合短片）；默认 `cover: true` 会把采样密度算成 `(columns*rows)/duration`，覆盖整段。
- `video_frames` 单次最多 16 帧（`max_frames` 默认 12），超过上限会按时间均匀抽样；间隔语义会被改变。`width` 只缩小不放大；ffmpeg 后端的 `quality` 参数不生效（统一 `q:v 2`）。
- 没有 ffmpeg 时 `video_probe`/`video_frames` 会回退 Chrome：Chrome 会冻结后台标签页，截帧期间标签页保持激活，且最好让 Chrome 窗口可见，否则 seek 可能变慢或超时；`video_scenes`/`video_sheet` 在回退模式下不可用。
- 一次工具结果里附加太多图片会受 DSH attachment 的服务端限制（默认每消息 20 张）；建议单次 ≤12 帧，或先用 `video_sheet` 看整体。
- `pixmax` 需要本机已安装并登录 Pixmax CLI；`tasks_wait` 可能长时间阻塞（默认 120s，可调到 600s）。工具能创建/修改/上传，但**不能提交生成**——提交请到 Pixmax 界面手动点。

## 隐私

本仓库**不包含**任何技能文件、`.state/`、`conversations/`、`images/`、`video-frames/` 等私有工作材料；`.gitignore` 已把它们排除。dsh-pixmax-workflow 的预设只组合工具，不读取也不依赖任何技能目录。

## 致谢

- [@angelky7/dsh-browser-control](https://github.com/angelky7/dsh-browser-control) — 本地 WebSocket/CDP 桥与 Chrome 扩展。

许可证：MIT（本仓库代码）。
