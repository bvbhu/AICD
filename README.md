# ShotFlow — DSH 插件：AI 视频生成工作流工具

一个 DSH bundle，提供 AI 视频生成工作流里最常用的两类工具，以及一个**只装工具**的预设：

1. **ChatGPT 网页工具** — `gpt_ask`（对话→Markdown）、`gpt_image`（生图/改图）、`gpt_last`（最近会话 id），另带 `gpt` CLI；`gpt_ask` / `gpt_image` 支持后台执行，生成期间不阻塞对话。`gpt_image` 由模型选择渠道：`browser`（ChatGPT 网页）或 `sensenova`（SenseNova U1.5 图像 API）。
2. **视频解析工具** — `video_probe`（时长/分辨率/帧率）、`video_frames`（按间隔/时间点/帧号截帧）、`video_scenes`（镜头切点）、`video_sheet`（总览图）。默认走 ffmpeg，没有 ffmpeg 时探测/截帧回退 Chrome；帧和总览图会作为图片附加到当前会话。
3. **Pixmax 只读工具** — `pixmax` 查询工作区/画布/节点/模型/任务/模板；**不提供任何会消耗积分或修改画布的操作**。
4. **「AI 视频工作流」预设** — 只组合上面这些工具与基础文件/命令/任务能力，不带自定义 persona、不绑定任何具体视频生成平台、不依赖任何技能文件。

不绑定固定平台：生成环节用你自己的工具链；ShotFlow 只负责网页对话/生图与本地视频解析。

> 仅供个人使用。把 ChatGPT 网页版当自动化接口批量调用不符合 OpenAI 的服务条款取向，请自行控制频率与风险。

---

## 组成

| 部分 | 内容 |
| --- | --- |
| gpt 工具 | `src/gpt-tools.mjs` → `gpt_ask` / `gpt_image` / `gpt_last` / `api_key`；`src/bridge.mjs` 是浏览器桥客户端，`src/chatgpt.mjs` 负责网页驱动，`bin/gpt.mjs` 是 CLI |
| 生图渠道 | `browser` 走 ChatGPT 网页（`src/chatgpt.mjs`）；`sensenova` 走 SenseNova Images API（`src/sensenova.mjs`）；密钥解析在 `src/credentials.mjs` |
| 后台任务 | `src/job-runner.mjs` → 把 `background: true` 的生成挂到 DSH `ctx.jobs`，完成后用 `job_output` 取结果 |
| 视频工具 | `src/video-tools.mjs` → `video_probe` / `video_frames` / `video_scenes` / `video_sheet`；`src/ffmpeg.mjs` 是主后端，`src/video-frames.mjs` 是无 ffmpeg 时的 Chrome 回退 |
| Pixmax 工具 | `src/pixmax-tools.mjs` → `pixmax` 只读查询；直接调用当前 runtime 的 `entry.py`，绕过启动器更新门禁 |
| 预设 | `cordis.patch.yml` 插入 `@deepseek-ai/dsh-agent-preset`：`id: ai-video-workflow`，`name: AI 视频工作流` |

## 运行时序

```
gpt_ask / gpt_image(browser) / gpt CLI
        │  优先复用已打开的 chatgpt.com 标签页；没有才新开
        │  HTTP POST /api/command（Bearer token）
        ▼
@angelky7/dsh-browser-control 桥（127.0.0.1:9777）→ DSH-Browser-Control 扩展 → 已登录 ChatGPT 标签页

gpt_image(channel=sensenova)
        │  POST https://token.sensenova.cn/v1/images/{generations|edits}
        ▼
保存 PNG/JPEG/WebP 到 <root>/images/

pixmax（只读）
        │  python <pixmaxHome>/runtime/versions/<current>/entry.py --json <command>
        ▼
Pixmax /user/api 只读端点（doctor/project/canvas/node/model/task/template）

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
| Chrome | 116+，且已登录 <https://chatgpt.com>（gpt 工具与视频回退都需要） |
| Chrome 扩展 | **DSH-Browser-Control**（与 `@angelky7/dsh-browser-control` 配套的那个，v1.7.2 实测） |
| DSH 插件 | `@angelky7/dsh-browser-control` 已安装并在设置中启用（默认端口 `9777`、token `dsh-local`） |
| SenseNova（可选） | 只用 `channel=sensenova` 时需要 `SENSENOVA_API_KEY`（环境变量优先，否则写入 DSH 凭据中心） |
| Pixmax CLI（可选） | 只用 `pixmax` 工具时需要本机已安装 `~/.pixmax-cli`；工具直接读当前 runtime，不触发更新门禁 |
| Node | ≥ 20（DSH 自带的 Node 即可） |

`ffmpegPath` 可以指向任意 ffmpeg 构建（共享构建需要同目录 DLL 一起保留）：

```yaml
- id: video-tools
  name: 'dsh-shotflow/video'
  config:
    ffmpegPath: 'D:/path/to/ffmpeg.exe'
```

不配置也可以：插件会依次尝试 `DSH_FFMPEG_PATH`、PATH、`C:\ffmpeg\bin`、`D:\ffmpeg\bin`、`C:\Program Files\FormatFactory`、`D:\Program Files\FormatFactory`、winget/chocolatey 的常见位置。`ffprobe` 不是必需——没有它时用 `ffmpeg -i` 解析时长/分辨率/帧率。

## 安装

```powershell
dsh plugin --profile <profile> add link:<repo>
# 然后把 "dsh-shotflow" 加入 dsh.profile.bundles（dsh plugin add 通常会自动加）
# 重启 DSH 后生效
```

桌面版 profile 由 Electron 应用管理；如果 CLI 安装被拒，用 DSH 的插件页/插件管理器安装同一个本地目录或打好的压缩包。

安装后：

- 新建会话时预设列表里出现 **「AI 视频工作流」**；
- 在该预设会话里可以直接调用 `gpt_ask` / `gpt_image` / `gpt_last` / `api_key`、`pixmax` 和 `video_probe` / `video_frames` / `video_scenes` / `video_sheet`；
- 其他预设（如内置 standard）里**没有**这些工具。

### 其他预设：手动启用工具

根级 `gpt-tools` / `video-tools` / `pixmax-tools` 默认关闭。需要时在 DSH 的插件/设置界面启用，或写进目标预设的 `plugins` 列表：

```yaml
- id: gpt-tools
  name: 'dsh-shotflow'
  config:
    bridgeUrl: 'http://127.0.0.1:9777'   # 可选
    token: 'dsh-local'                   # 可选
    reuseExistingTab: true               # 默认 true：优先复用已打开的 chatgpt.com 标签页
    root: 'D:/path/to/outputs'           # 可选，默认 ~/.dsh/gpt-web
    # sensenovaBaseUrl / sensenovaModel 也可覆盖
- id: video-tools
  name: 'dsh-shotflow/video'
  config:
    bridgeUrl: 'http://127.0.0.1:9777'   # 可选
    token: 'dsh-local'                   # 可选
    ffmpegPath: 'D:/path/to/ffmpeg.exe'  # 可选；不填则自动找
    root: 'D:/path/to/outputs'           # 可选，默认 ~/.dsh/gpt-web
- id: pixmax-tools
  name: 'dsh-shotflow/pixmax'
  config:
    pixmaxHome: 'C:/Users/you/.pixmax-cli'  # 可选
    environment: cn                         # 可选：cn | global
```

> DSH 的 preset 覆盖是**整份 `plugins` 列表替换**，不是逐项合并；覆盖内置 preset 时记得把原有条目一起带上。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `gpt_ask` | `prompt`(必填)、`file[]`、`conversation`、`out`、`timeout`、`background` | `conversation_id`、`text`、Markdown `path`、`url`、`title`（后台模式返回 `job_id`） |
| `gpt_image` | `prompt`(必填)、**`channel`(必填)**、`ref[]`、`out`、`size`、`format`、`watermark`、`model`、`timeout`、`background` | 图片绝对 `path`、`channel`、`conversation_id`、宽高（后台模式返回 `job_id`） |
| `gpt_last` | — | 最近会话的 `conversation_id` / `url` / `path` |
| `api_key` | `service`(`sensenova`/`pixmax`)、`action`(`status`/`set`/`clear`)、`value` | 是否配置、来源（env/凭据中心）、是否允许写入 |
| `pixmax` | `action`、`selector`、`query`、`type`、`generated`、`online`、`timeout` | 只读 JSON 查询结果 |
| `video_probe` | `path`(必填) | `duration`、`width` / `height`、`fps`、`codec`、`backend` |
| `video_frames` | `path`(必填)、`every` / `times` / `frames` 三选一、`from`、`to`、`max_frames`、`width`、`quality`、`out`、`attach`、`backend` | 帧文件路径 + 元数据，并把帧附加到当前会话 |
| `video_scenes` | `path`(必填)、`threshold`、`max_scenes`、`from`、`to` | 镜头切点时间列表（ffmpeg） |
| `video_sheet` | `path`(必填)、`fps`、`cover`、`columns`、`rows`、`width`、`out`、`attach` | 一张总览图，并附加到当前会话 |

- `conversation` 支持 conversation id、`https://chatgpt.com/c/<id>` 或 `last`。
- `file` 会作为文本上下文拼在 prompt 前面。
- `gpt_image` 的 `channel` 必须由模型选择，渠道特点见下文。
- gpt 调用**优先复用已打开的 chatgpt.com 标签页**（会在里面点“新聊天”或打开指定会话）；没有可用标签页时才新开一个后台标签页。串行执行：同一时间不要并发调用。

### 生图渠道：模型选 `channel`

`gpt_image` 必须指定渠道，工具描述里已经写明两条路的差异：

| 渠道 | 特点 |
| --- | --- |
| `browser` | ChatGPT 网页版。不需要 API key，用网页额度；支持参考图/编辑；分钟级；依赖 Chrome 登录，可能被 Cloudflare 拦截；固定输出 PNG；有 ChatGPT 会话上下文 |
| `sensenova` | SenseNova U1.5 图像 API。需要 `SENSENOVA_API_KEY`，**按张消耗积分**；同步数秒级；支持 1–5 张参考图编辑；尺寸 512–4096/2K/4K；输出 png/jpeg/webp；无 ChatGPT 对话上下文；稳定、可后台 |

```text
gpt_image prompt="雨夜霓虹街道，电影感" channel="browser"
gpt_image prompt="把这张图改成水彩" ref=["cat.png"] channel="sensenova" size="2048x2048" format="webp"
```

- `browser`：`size` 只是写进 prompt 的提示；输出固定 PNG。
- `sensenova`：`size` 会映射到接口支持的值（`auto`/`2K`/`4K`/`1:1`/`16:9`/`9:16`/`3:2`/`2:3`，或 512–4096 且为 32 倍数的 `WxH`）；`watermark` 默认 `false`（显式传给接口）；`model` 默认 `sensenova-u1.5-lite`，可换 `sensenova-u1.5-fast`。
- 两者都支持 `background: true`。

### API key：环境变量优先，凭据中心兜底

读取顺序与 DSH 模型配置页面一致：

1. 环境变量（`SENSENOVA_API_KEY` / `PIXMAX_BEARER_TOKEN`）——**优先，且一旦存在就拒绝写入凭据中心**；
2. 否则读 DSH 凭据中心（`ctx.credentials`）。

```text
api_key service="sensenova" action="status"
api_key service="sensenova" action="set" value="sk-..."
api_key service="sensenova" action="clear"
```

- `status` 只返回是否配置、来源（`env`/`credentials`）和是否允许写入，不返回值。
- 环境变量已设置时 `set` 会明确报错：“按优先级不会再写入凭据中心；如需在凭据中心管理，请先移除该环境变量。”
- `clear` 只删凭据中心的值；环境变量仍然优先。
- 代码和仓库里不保存任何 key；Pixmax 的 Bearer token 同样走这套（`PIXMAX_BEARER_TOKEN`），没有时回退 Pixmax CLI 自己的登录会话。

### Pixmax：只读查询，不消耗积分

`pixmax` 工具只暴露**零积分、只读**命令：

```text
pixmax action="doctor"
pixmax action="session_status"
pixmax action="project_list"
pixmax action="canvas_summary"
pixmax action="canvas_nodes" generated=true
pixmax action="node_get" selector="<uuid>"
pixmax action="model_search" query="pix" type="GENERATE_IMAGE"
pixmax action="tasks_detail" selector="<task-uuid>"
pixmax action="templates_list"
```

- 没有 generate / submit / upload / create / update / delete / run / raw，**工具无法花积分或改画布**。
- 直接调用 `~/.pixmax-cli/runtime/current.json` 指向的 `entry.py`，绕过启动器的更新门禁（本机曾遇到运行时下载超时导致 `pixmax` 启动失败）。
- 固定 `--json`；超时默认 120s、最大 600s；只读查询可并发。
- 需要 `selector` 的 action 会明确报错；命令参数在工具内白名单构造，不接受裸参数透传。
- 如果 CLI 未安装，工具会返回可读错误；README 不打包 CLI。

### 异步调用：`background: true`

`gpt_ask` / `gpt_image` 都支持后台执行。生成期间不再占住当前对话轮次：

```text
gpt_ask  prompt="审查这段视频脚本" background=true
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

## CLI

```powershell
gpt ask "用一句话解释 CAP 定理"
gpt ask "审查这段代码" -f src/server.py -o out.md
git diff | gpt ask "解释改动风险" --plain
gpt ask "把 token 改成 15 分钟过期" -c last
gpt ask "再补一个刷新接口" -c https://chatgpt.com/c/<id>
gpt ask "只回复 OK" --print-id

gpt image "戴宇航头盔的橘猫，白底产品摄影"
gpt image "改成水彩风格，保留轮廓" -i cat.png -o cat2.png
gpt image "..." --size 16:9 --json

gpt last --json
gpt doctor
```

- `ask` 默认把提问+回复写成 `<root>/conversations/<会话前8位>-<时间>-<摘要>.md`（frontmatter 带 conversation_id / url / title）；`--plain` 只写回复正文，`--no-save` 不落盘，`--json` 结构化，`--print-id` 只打印 id。
- `image` 默认写 `<root>/images/<时间>-<摘要>.png`；网页返回的就是 PNG。
- 输出根目录：环境变量 `DSH_GPT_ROOT`；CLI 默认是仓库根，插件默认是 `~/.dsh/gpt-web`，也可在插件配置里用 `root` 指定。
- CLI 不提供后台模式；需要不阻塞时用 DSH 工具。

## 目录

```
.
├─ package.json          # dsh-shotflow bundle + CLI bin
├─ cordis.patch.yml      # 根级 gpt-tools/video-tools/pixmax-tools（默认关）+ AI 视频工作流 preset
├─ bin/
│  ├─ gpt.mjs            # CLI
│  └─ gpt.cmd            # Windows 启动器
├─ src/
│  ├─ gpt-tools.mjs      # ChatGPT / api_key 工具注册
│  ├─ sensenova.mjs      # SenseNova 图像 API 渠道
│  ├─ credentials.mjs    # 环境变量优先 / DSH 凭据中心兜底
│  ├─ video-tools.mjs    # 视频工具注册
│  ├─ ffmpeg.mjs         # ffmpeg 后端：探测/截帧/切点/拼图
│  ├─ pixmax-tools.mjs   # Pixmax 只读工具（直接调 runtime entry.py）
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

- 网页驱动走 **DSH-Browser-Control 扩展 + 桥接**，优先复用已打开的 chatgpt.com 标签页，避免新标签页被 Cloudflare 拦截；所有 gpt 调用串行。
- 生图分渠道：`browser` 复用网页登录态，`sensenova` 走 API 并复用同一套 `background` / `api_key` / 保存逻辑。
- 视频主后端是 **ffmpeg**：单遍滤镜、精确 seek、切点与总览图都更准更快；Chrome 回退只用于没有 ffmpeg 的应急场景。
- Pixmax 只做**只读**工具，直接调当前 runtime 的 `entry.py`，不暴露任何生成/提交/写画布命令，因此不需要“零积分”人工约束。
- 预设**只组合工具**：没有自定义 persona，不引用任何技能文件，也不绑定某个视频生成平台；生成环节由使用者自己的工具链完成。
- 后台任务走 DSH `ctx.jobs`：结果与完成通知由 DSH 统一管理，插件不自己维护轮询进程。

## 已知限制

- 同一扩展桥接一次只能串行驱动一个页面动作；gpt 工具在进程内串行执行。
- gpt 默认复用已打开的 chatgpt.com 标签页：会在该标签页里点“新聊天”或打开指定会话，可能改变你当前的页面；没有找到标签页时才新开。
- Free 套餐有生图额度；额度用尽会明确报错，不会静默挂起或保存错图。
- `channel=sensenova` 会按张消耗 SenseNova 积分；需要 `SENSENOVA_API_KEY`；`watermark` 默认显式传 `false`，接口未来若调整默认值不受影响。输出尺寸受 512–4096、32 倍数、3:1 比例限制。
- `api_key` 写入的是 DSH 凭据中心；环境变量存在时拒绝写入。`status` 不会返回值。
- 面板窗口的「锁定」、只读/禁脚本策略由浏览器扩展控制；被拦住时命令会带可读错误返回。
- 网页改版可能让选择器失效；`src/chatgpt.mjs` 里的 composer / send 选择器集中在一处，便于修。
- 视频主后端是 ffmpeg：`ffmpegPath` 指向不存在的文件会明确报错；共享构建需要同目录 DLL 一起保留（spawn 时会把工作目录设为 ffmpeg 所在目录）。
- `video_scenes` 只检测高于 `threshold` 的硬切；渐变/溶解转场可能漏检，阈值要按素材微调。
- `video_sheet` 显式给 `fps` 时只取前 `columns*rows` 个采样帧（适合短片）；默认 `cover: true` 会把采样密度算成 `(columns*rows)/duration`，覆盖整段。
- `video_frames` 单次最多 16 帧（`max_frames` 默认 12），超过上限会按时间均匀抽样；间隔语义会被改变。`width` 只缩小不放大；ffmpeg 后端的 `quality` 参数不生效（统一 `q:v 2`）。
- 没有 ffmpeg 时 `video_probe`/`video_frames` 会回退 Chrome：Chrome 会冻结后台标签页，截帧期间标签页保持激活，且最好让 Chrome 窗口可见，否则 seek 可能变慢或超时；`video_scenes`/`video_sheet` 在回退模式下不可用。
- 一次工具结果里附加太多图片会受 DSH attachment 的服务端限制（默认每消息 20 张）；建议单次 ≤12 帧，或先用 `video_sheet` 看整体。
- `pixmax` 只读工具需要本机已安装并登录 Pixmax CLI；`tasks_wait` 可能长时间阻塞（默认 120s，可调到 600s）。工具不提供任何生成/提交/上传/写画布能力。

## 隐私

本仓库**不包含**任何技能文件、`.state/`、`conversations/`、`images/`、`video-frames/` 等私有工作材料；`.gitignore` 已把它们排除。ShotFlow 的预设只组合工具，不读取也不依赖任何技能目录。

## 致谢

- [@angelky7/dsh-browser-control](https://github.com/angelky7/dsh-browser-control) — 本地 WebSocket/CDP 桥与 Chrome 扩展。

许可证：MIT（本仓库代码）。
