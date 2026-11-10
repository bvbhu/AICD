# AICD — DSH 复合插件：GPT 网页工具 + 视频解析 + ai漫剧师预设

一个 DSH bundle，三件事：

1. **gpt tool** — 把 ChatGPT 网页版变成模型可调用的工具：`gpt_ask`（对话→Markdown）、`gpt_image`（生图→PNG）、`gpt_last`（最近会话 id），另带一个 `gpt` CLI。`gpt_ask` / `gpt_image` 支持 `background: true`：生成放到 DSH 后台 job，立即返回，不阻塞对话。
2. **视频解析** — `video_probe`（时长/分辨率/帧率）、`video_frames`（按间隔/时间点/帧号截帧）、`video_scenes`（自动找镜头切点）、`video_sheet`（拼总览图）；帧和总览图会作为图片附加到当前会话，让图像模型直接分析。
3. **ai漫剧师预设** — 从旧 AIGC 漫剧项目的 git 记录找回的 agent preset（`aigc-comic-pipeline`，全流程模式）。该预设**自带** gpt tool 和视频工具；其他预设默认没有，需要手动启用。

gpt 工具通过 **DSH Browser Control 桥接（@angelky7/dsh-browser-control，127.0.0.1:9777）** 驱动你已登录的真实 Chrome，用的是 DSH `browser_*` 工具那一个 **DSH-Browser-Control Chrome 扩展**；没有 API key、没有 headless、不烧 API 额度。视频工具**优先走 ffmpeg**（路径可配置，Format Factory 自带的 ffmpeg 也能直接用），没有 ffmpeg 时才回退到 Chrome 解码。gpt 部分不需要 Python；视频的量化比对（Pillow）属于可选的下游分析。

> 仅供个人使用。把 ChatGPT 网页版当自动化接口批量调用不符合 OpenAI 的服务条款取向，请自行控制频率与风险。

---

## 组成

| 部分 | 内容 |
| --- | --- |
| gpt 工具插件 | `src/gpt-tools.mjs` → 注册 `gpt_ask` / `gpt_image` / `gpt_last`；`src/bridge.mjs` 是浏览器桥客户端，`src/chatgpt.mjs` 负责网页驱动，`bin/gpt.mjs` 是 CLI |
| 视频工具插件 | `src/video-tools.mjs` → 注册 `video_probe` / `video_frames` / `video_scenes` / `video_sheet`；`src/ffmpeg.mjs` 是 ffmpeg 后端（探测/单遍截帧/切点/拼图），`src/video-frames.mjs` 是无 ffmpeg 时的 Chrome 回环截帧 |
| 预设 | `cordis.patch.yml` 插入 `@deepseek-ai/dsh-agent-preset` 行：`id: aigc-comic-pipeline`，`name: ai漫剧师`，`order: 20` |
| 预设里的工具 | 预设 `plugins` 列表里有 `id: gpt-tools, name: 'dsh-aicd'` 和 `id: video-tools, name: 'dsh-aicd/video'` |
| 其他预设 | 根级 `gpt-tools` / `video-tools` 行默认 `disabled: true`；需要时手动启用（见下文） |

## 运行时序

```
gpt_ask / gpt_image / gpt CLI
        │  HTTP POST /api/command（Bearer token）
        ▼
@angelky7/dsh-browser-control 桥（127.0.0.1:9777）
        │  WebSocket
        ▼
DSH-Browser-Control Chrome 扩展（v1.7.2）
        │  chrome.debugger → CDP
        ▼
你已登录的 chatgpt.com 标签页（gpt 每次新开一个后台标签，做完即关）

video_probe / video_frames / video_scenes / video_sheet
        │  ffmpeg（优先；ffmpegPath 可配置）
        │  ffmpeg -i 探测 / fps+select 单遍截帧 / scene+showinfo 找切点 / tile 拼图
        ▼
DSH attachments 服务 → 作为图片块附加到当前会话，交给图像模型分析

        （没有 ffmpeg 时的回退）
        本地回环 HTTP（随机端口 + 随机 token）→ Chrome <video> 解码 → canvas JPEG
```

回复不是从 DOM 抄的：它读取 `/backend-api/conversation/<id>` 的 `content.parts`，所以 Markdown 表格、代码块、加粗都保真。

---

## 前置条件

| 组件 | 要求 |
| --- | --- |
| DSH | 0.2.2 系列（本仓库在 `0.2.2-rc.1` 上实测） |
| ffmpeg | **推荐**。视频工具默认找 `ffmpegPath` 配置 → `DSH_FFMPEG_PATH` → PATH → 常见安装目录（含 Format Factory）。没有 ffmpeg 时只有 `video_probe`/`video_frames` 能回退到 Chrome |
| Chrome | 116+，且已登录 <https://chatgpt.com>（gpt 工具与视频回退都需要） |
| Chrome 扩展 | **DSH-Browser-Control**（与 `@angelky7/dsh-browser-control` 配套的那个，v1.7.2 实测） |
| DSH 插件 | `@angelky7/dsh-browser-control` 已安装并在设置中启用（默认端口 `9777`、token `dsh-local`） |
| Node | ≥ 20（DSH 自带的 Node 即可） |

ffmpeg 可以这样指定（Format Factory 自带的就是一个完整构建，实测 7.1）：

```yaml
- id: video-tools
  name: 'dsh-aicd/video'
  config:
    ffmpegPath: 'D:/Program Files/FormatFactory/ffmpeg.exe'
```

不配置也可以：插件会依次尝试 `DSH_FFMPEG_PATH`、PATH、`C:\ffmpeg\bin`、`D:\ffmpeg\bin`、`C:\Program Files\FormatFactory`、`D:\Program Files\FormatFactory`、winget/chocolatey 的常见位置。`ffprobe` 不是必需——没有它时用 `ffmpeg -i` 解析时长/分辨率/帧率。

先确认桥接在线：

```powershell
Invoke-RestMethod http://127.0.0.1:9777/api/status | ConvertTo-Json -Depth 4
# extensionConnected 应为 true，hello.version 为扩展版本
```

或：

```powershell
gpt doctor
```

## 安装到 DSH

```powershell
dsh plugin --profile desktop add link:<repo>
# 然后把 "dsh-aicd" 加入 dsh.profile.bundles（dsh plugin add 通常会自动加）
# 重启 DSH 后生效
```

桌面版 profile 由 Electron 应用管理；如果 CLI 安装被拒，用 DSH 的插件页/插件管理器安装同一个本地目录或打好的压缩包。

安装后：

- 新建会话时预设列表里出现 **「ai漫剧师」**；
- 在 ai漫剧师会话里可以直接调用 `gpt_ask` / `gpt_image` / `gpt_last` 和 `video_probe` / `video_frames` / `video_scenes` / `video_sheet`；
- 其他预设（如内置 standard）里**没有**这些工具。

---

## 其他预设：手动启用工具

有两种方式，任选其一。

### 方式 A：启用根级开关（推荐）

bundle 已经插入了根级 `gpt-tools` 和 `video-tools` 两行，默认关闭。在 DSH 的插件/设置界面启用对应行（等价于把 `cordis.patch.yml` 里该行改成 `disabled: false`）：

```yaml
- insert:
    - id: gpt-tools
      name: 'dsh-aicd'
      disabled: false
    - id: video-tools
      name: 'dsh-aicd/video'
      disabled: false
```

此后所有未自带这些工具的预设都能看到它们。使用 ai漫剧师预设时建议保持根级关闭（预设本身已有一份），避免同一工具注册两次。

### 方式 B：写进目标预设的 plugins 列表

在目标预设（通过 profile patch 覆盖该 preset 行、或在自定义 bundle 里新建 preset）的 `plugins` 数组末尾加：

```yaml
- id: gpt-tools
  name: 'dsh-aicd'
  config:
    bridgeUrl: 'http://127.0.0.1:9777'   # 可选
    token: 'dsh-local'                   # 可选
    root: 'D:/path/to/outputs'           # 可选，默认 ~/.dsh/gpt-web
- id: video-tools
  name: 'dsh-aicd/video'
  config:
    bridgeUrl: 'http://127.0.0.1:9777'   # 可选
    token: 'dsh-local'                   # 可选
    ffmpegPath: 'D:/Program Files/FormatFactory/ffmpeg.exe'  # 可选；不填则自动找
    root: 'D:/path/to/outputs'           # 可选，默认 ~/.dsh/gpt-web
```

> DSH 的 preset 覆盖是**整份 `plugins` 列表替换**，不是逐项合并；覆盖内置 preset 时记得把原有条目一起带上。

---

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `gpt_ask` | `prompt`(必填)、`file[]`、`conversation`、`out`、`timeout`、`background` | `conversation_id`、`text`、Markdown `path`、`url`、`title`（后台模式返回 `job_id`） |
| `gpt_image` | `prompt`(必填)、`ref[]`、`out`、`size`、`timeout`、`background` | 图片绝对 `path`、`conversation_id`、宽高（后台模式返回 `job_id`） |
| `gpt_last` | — | 最近会话的 `conversation_id` / `url` / `path` |
| `video_probe` | `path`(必填) | `duration`、`width` / `height`、`fps`、`codec`、`backend` |
| `video_frames` | `path`(必填)、`every` / `times` / `frames` 三选一、`from`、`to`、`max_frames`、`width`、`quality`、`out`、`attach`、`backend` | 帧文件路径 + 元数据，并把帧附加到当前会话 |
| `video_scenes` | `path`(必填)、`threshold`、`max_scenes`、`from`、`to` | 镜头切点时间列表（ffmpeg） |
| `video_sheet` | `path`(必填)、`fps`、`cover`、`columns`、`rows`、`width`、`out`、`attach` | 一张总览图，并附加到当前会话 |

- `conversation` 支持 conversation id、`https://chatgpt.com/c/<id>` 或 `last`。
- `file` 会作为文本上下文拼在 prompt 前面。
- `size` 只是写进 prompt 的尺寸提示（网页生图不保证精确像素）。
- 每次 gpt 调用都会新开一个**后台**标签页，结束即关；不用你手动点网页。
- 串行使用：同一时间不要并发跑多个 `gpt_ask`。

### 异步调用：`background: true`

`gpt_ask` / `gpt_image` 都支持后台执行。生成期间不再占住当前对话轮次：

```text
gpt_ask  prompt="审查这版剧本" background=true
→ { status: "running", job_id: "gpt-1a2b3c4d5e6f7890" }

（继续聊别的事）

job_output job_id="gpt-1a2b3c4d5e6f7890"
→ [gpt] 完成
  {"status":"completed","conversation_id":"...","path":"...","url":"...","title":"...","text":"...","text_truncated":false}
```

- 工具立即返回 `job_id`，真正的生成在 DSH 后台任务里跑；完成后 `@deepseek-ai/dsh-tool-jobs` 会**在会话内发完成通知**，不用轮询。
- 结果用 `job_output` 读；不要了就 `job_kill`。取消会关掉对应的 ChatGPT 标签页。
- 后台任务依赖 `ctx.jobs` 与 `dsh-tool-jobs` 控制器：ai漫剧师预设已内置 `tool-jobs`；如果某个预设没有它，`background: true` 会明确报“没有可用的后台任务服务”。
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

## 目录

```
.
├─ package.json          # dsh-aicd bundle + CLI bin
├─ cordis.patch.yml      # 根级 gpt-tools/video-tools（默认关）+ ai漫剧师 preset
├─ bin/
│  ├─ gpt.mjs            # CLI
│  └─ gpt.cmd            # Windows 启动器
├─ src/
│  ├─ gpt-tools.mjs      # ChatGPT 工具注册
│  ├─ video-tools.mjs    # 视频工具注册
│  ├─ ffmpeg.mjs         # ffmpeg 后端：探测/截帧/切点/拼图
│  ├─ bridge.mjs         # DSH Browser Control HTTP 客户端
│  ├─ chatgpt.mjs        # 网页驱动：ask / 续聊 / 生图
│  ├─ job-runner.mjs     # background=true 的 DSH 后台 job 包装
│  ├─ video-frames.mjs   # 无 ffmpeg 时的回环 HTTP + Chrome 解码 + canvas 截帧
│  └─ store.mjs          # 路径、Markdown、last.json
├─ skills/               # 本地私有技能，公开仓库不包含
├─ conversations/        # 运行产物（gitignore）
├─ images/               # 运行产物（gitignore）
├─ video-frames/         # 截帧产物（gitignore）
└─ .state/               # 运行状态（gitignore）
```

## 与旧版的差异

- 驱动层从 `chrome-use`（自己一套扩展 + native messaging）换成 **DSH-Browser-Control 扩展 + 桥接**，与 DSH 浏览器工具共用同一条链路。
- 删除 `chatgpt-use.exe`、`image-use`、Python 依赖；生图和续聊都用同一套网页驱动重写。
- 不再支持 `--model`（网页模型档位）与 `--project`（ChatGPT Project 归档）：桥接驱动保持当前账号/当前默认模型，新会话是普通会话。
- `--format` 移除：网页生图统一返回 PNG。

## 已知限制

- 同一扩展桥接一次只能串行驱动一个页面动作；不要并发调用。
- Free 套餐有生图额度；额度用尽会明确报错（`你已达到 Free 套餐的图像生成请求上限…`），不会静默挂起或保存错图。
- 面板窗口的「锁定」、只读/禁脚本策略由浏览器扩展控制；被拦住时命令会带可读错误返回。
- 网页改版可能让选择器失效；`src/chatgpt.mjs` 里的 composer / send 选择器集中在一处，便于修。
- 会话记录接口不可用时 `gpt_ask` 会失败，而不是退化成抓 innerText。
- 视频主后端是 ffmpeg：`ffmpegPath` 指向不存在的文件会明确报错；Format Factory 之类的共享构建需要同目录 DLL 一起保留（spawn 时会把工作目录设为 ffmpeg 所在目录）。
- `video_scenes` 只检测高于 `threshold` 的硬切；渐变/溶解转场可能漏检，阈值要按素材微调。
- `video_sheet` 显式给 `fps` 时只取前 `columns*rows` 个采样帧（适合短片）；默认 `cover: true` 会把采样密度算成 `(columns*rows)/duration`，覆盖整段。
- `video_frames` 单次最多 16 帧（`max_frames` 默认 12），超过上限会按时间均匀抽样；间隔语义会被改变。
- `width` 只缩小不放大；源视频 320×176 时设 1280 仍是 320×176。ffmpeg 后端的 `quality` 参数不生效（统一 `q:v 2`）。
- 没有 ffmpeg 时 `video_probe`/`video_frames` 会回退 Chrome：Chrome 会冻结后台标签页，截帧期间标签页保持激活，且最好让 Chrome 窗口可见，否则 seek 可能变慢或超时；`video_scenes`/`video_sheet` 在回退模式下不可用。
- 一次工具结果里附加太多图片会受 DSH attachment 的服务端限制（默认每消息 20 张）；建议单次 ≤12 帧，或先用 `video_sheet` 看整体。

## 隐私

本仓库**不包含** `skills/`、`.state/`、`conversations/`、`images/`、`video-frames/` 等私有工作材料；`.gitignore` 已把它们排除。ai漫剧师预设只提供入口与插件组合，具体技能（`aigc-comic-pipeline`、`aigc-asset-generation`、`aigc-vault-rules` 等）由使用者本地提供。

## 致谢

- [@angelky7/dsh-browser-control](https://github.com/angelky7/dsh-browser-control) — 本地 WebSocket/CDP 桥与 Chrome 扩展。
- ChatGPT 网页驱动思路源自早期的 `gpt` CLI（chrome-use 版本）。

许可证：MIT（本仓库代码）。
