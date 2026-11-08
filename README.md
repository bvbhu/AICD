# AICD — DSH 复合插件：GPT 网页工具 + ai漫剧师预设

一个 DSH bundle，两件事：

1. **gpt tool** — 把 ChatGPT 网页版变成模型可调用的工具：`gpt_ask`（对话→Markdown）、`gpt_image`（生图→PNG）、`gpt_last`（最近会话 id），另带一个 `gpt` CLI。
2. **ai漫剧师预设** — 从旧 AIGC 漫剧项目的 git 记录找回的 agent preset（`aigc-comic-pipeline`，全流程模式）。该预设**自带** gpt tool；其他预设默认没有，需要手动启用。

gpt tool 不再使用 `chrome-use` / `chatgpt-use` / `image-use`，也不依赖 Python：它通过 **DSH Browser Control 桥接（@angelky7/dsh-browser-control，127.0.0.1:9777）** 驱动你已登录的真实 Chrome，用的就是 DSH `browser_*` 工具那一个 **DSH-Browser-Control Chrome 扩展**。没有 API key，没有 headless，不烧 API 额度。

> 仅供个人使用。把 ChatGPT 网页版当自动化接口批量调用不符合 OpenAI 的服务条款取向，请自行控制频率与风险。

---

## 组成

| 部分 | 内容 |
| --- | --- |
| gpt 工具插件 | `src/gpt-tools.mjs` → 注册 `gpt_ask` / `gpt_image` / `gpt_last`；`src/bridge.mjs` 是浏览器桥客户端，`src/chatgpt.mjs` 负责网页驱动，`bin/gpt.mjs` 是 CLI |
| 预设 | `cordis.patch.yml` 插入 `@deepseek-ai/dsh-agent-preset` 行：`id: aigc-comic-pipeline`，`name: ai漫剧师`，`order: 20` |
| 预设里的 gpt 工具 | 预设 `plugins` 列表里有一行 `id: gpt-tools, name: 'dsh-aicd'` |
| 其他预设 | 根级 `gpt-tools` 行默认 `disabled: true`；需要时手动启用（见下文） |

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
```

回复不是从 DOM 抄的：它读取 `/backend-api/conversation/<id>` 的 `content.parts`，所以 Markdown 表格、代码块、加粗都保真。

---

## 前置条件

| 组件 | 要求 |
| --- | --- |
| DSH | 0.2.2 系列（本仓库在 `0.2.2-rc.1` 上实测） |
| Chrome | 116+，且已登录 <https://chatgpt.com> |
| Chrome 扩展 | **DSH-Browser-Control**（与 `@angelky7/dsh-browser-control` 配套的那个，v1.7.2 实测） |
| DSH 插件 | `@angelky7/dsh-browser-control` 已安装并在设置中启用（默认端口 `9777`、token `dsh-local`） |
| Node | ≥ 20（DSH 自带的 Node 即可） |

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
- 在 ai漫剧师会话里可以直接调用 `gpt_ask` / `gpt_image` / `gpt_last`；
- 其他预设（如内置 standard）里**没有**这些工具。

---

## 其他预设：手动启用 gpt 工具

有两种方式，任选其一。

### 方式 A：启用根级开关（推荐）

bundle 已经插入了一行根级 `gpt-tools`，默认关闭。在 DSH 的插件/设置界面把它启用（等价于把 `cordis.patch.yml` 里这一行改成 `disabled: false`）：

```yaml
- insert:
    - id: gpt-tools
      name: 'dsh-aicd'
      disabled: false
```

此后所有未自带 gpt 工具的预设都能看到这三个工具。使用 ai漫剧师预设时建议保持根级关闭（预设本身已有一份），避免同一工具注册两次。

### 方式 B：写进目标预设的 plugins 列表

在目标预设（通过 profile patch 覆盖该 preset 行、或在自定义 bundle 里新建 preset）的 `plugins` 数组末尾加：

```yaml
- id: gpt-tools
  name: 'dsh-aicd'
  config:
    bridgeUrl: 'http://127.0.0.1:9777'   # 可选
    token: 'dsh-local'                   # 可选
    root: 'D:/path/to/outputs'           # 可选，默认 ~/.dsh/gpt-web
```

> DSH 的 preset 覆盖是**整份 `plugins` 列表替换**，不是逐项合并；覆盖内置 preset 时记得把原有条目一起带上。

---

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `gpt_ask` | `prompt`(必填)、`file[]`、`conversation`、`out`、`timeout` | `conversation_id`、`text`、Markdown `path`、`url`、`title` |
| `gpt_image` | `prompt`(必填)、`ref[]`、`out`、`size`、`timeout` | 图片绝对 `path`、`conversation_id`、宽高 |
| `gpt_last` | — | 最近会话的 `conversation_id` / `url` / `path` |

- `conversation` 支持 conversation id、`https://chatgpt.com/c/<id>` 或 `last`。
- `file` 会作为文本上下文拼在 prompt 前面。
- `size` 只是写进 prompt 的尺寸提示（网页生图不保证精确像素）。
- 每次调用都会新开一个**后台**标签页，结束即关；不用你手动点网页。
- 串行使用：同一时间不要并发跑多个 `gpt_ask`。

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
├─ cordis.patch.yml      # 根级 gpt-tools（默认关）+ ai漫剧师 preset
├─ bin/
│  ├─ gpt.mjs            # CLI
│  └─ gpt.cmd            # Windows 启动器
├─ src/
│  ├─ gpt-tools.mjs      # DSH 工具注册
│  ├─ bridge.mjs         # DSH Browser Control HTTP 客户端
│  ├─ chatgpt.mjs        # 网页驱动：ask / 续聊 / 生图
│  └─ store.mjs          # 路径、Markdown、last.json
├─ skills/               # 本地私有技能，公开仓库不包含
├─ conversations/        # 运行产物（gitignore）
├─ images/               # 运行产物（gitignore）
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

## 隐私

本仓库**不包含** `skills/`、`.state/`、`conversations/`、`images/` 等私有工作材料；`.gitignore` 已把它们排除。ai漫剧师预设只提供入口与插件组合，具体技能（`aigc-comic-pipeline`、`aigc-asset-generation`、`aigc-vault-rules` 等）由使用者本地提供。

## 致谢

- [@angelky7/dsh-browser-control](https://github.com/angelky7/dsh-browser-control) — 本地 WebSocket/CDP 桥与 Chrome 扩展。
- ChatGPT 网页驱动思路源自早期的 `gpt` CLI（chrome-use 版本）。

许可证：MIT（本仓库代码）。
