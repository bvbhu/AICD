# 项目交接文档 — dsh-pixmax-workflow

> 更新时间：2026-11-11 20:15 CST
> 仓库：`D:\projects\dsh-pixmax-workflow`（git repo）
> 远程：`origin → https://github.com/bvbhu/dsh-pixmax-workflow.git`（原名 `bvbhu/dsh-shotflow`，已改名；旧地址自动重定向）
> 基线提交：`a93a0e3` feat(pixmax): 报错引导（CLI 安装配置 / 查阅 skill）+ 四条目清单与 GitHub 安装说明
> 分支：main（默认），已推送并跟踪 `origin/main`
> 安装状态：已通过 `dsh plugin --profile desktop add github:bvbhu/dsh-pixmax-workflow` 装到桌面版 profile（v0.3.0）

---

## 一、项目定位

DSH 插件 bundle（本地开发起家，现从 GitHub 安装，未发布 npm）。为 AI 视频生成工作流提供工具 + 一个只装工具的预设 + 一个设置页。

**四个可独立开关的条目**，各自在 DSH 插件/设置界面单独启用或关闭，互不影响：

| 条目 | 条目 id | 包路径 / 类型 | 内容 |
|------|---------|---------------|------|
| 图像工具 | `image-tools` | `dsh-pixmax-workflow/image` | `model_list`、`image_generation`（默认关） |
| 视频工具 | `video-tools` | `dsh-pixmax-workflow/video` | `video_probe`、`video_frames`、`video_scenes`、`video_sheet`（默认关） |
| Pixmax 工具 | `pixmax-tools` | `dsh-pixmax-workflow/pixmax` | `pixmax`（81 个 action + `command` 直通）（默认关） |
| 「AI 视频工作流」预设 | `preset-ai-video-workflow` | `@deepseek-ai/dsh-agent-preset` | 只组合上面这些工具与基础文件/命令/任务能力，不带自定义 persona、不绑定平台、不依赖技能文件（默认开） |

**辅助行** `pixmax-workflow-settings`（`dsh-pixmax-workflow/settings`）默认启用，不注册任何工具，只提供设置页 HTTP 桥与插件页卡片；预设内部也会引用它。它不属于上面四个可独立开关的条目。

三个工具行默认关，是为了不污染其他预设；预设自带已启用的工具副本，所以关掉根级工具行不影响预设会话。

---

## 二、目录结构

```
D:\projects\dsh-pixmax-workflow\
├─ package.json          # dsh-pixmax-workflow 0.3.0；main → ./src/image-tools.mjs
├─ cordis.patch.yml      # 四个可独立开关的条目（3 个默认关的工具行 + 默认开的预设）+ 设置页辅助行
├─ icon.svg              # 插件图标
├─ client/
│  └─ pixmax-workflow-settings.js   # 插件页生图模型设置卡片（React.createElement，无构建）
├─ locale/
│  ├─ en.json
│  └─ zh.json
├─ src/
│  ├─ image-tools.mjs    # 注册 model_list / image_generation；inject=['tools']
│  ├─ image-models.mjs   # 生图模型注册表 + <root>/settings.json 读写 + 内置模型
│  ├─ image-api.mjs      # OpenAI Images 兼容端点客户端（JSON data-URL / multipart）
│  ├─ sensenova.mjs      # SenseNova 兼容包装（复用 image-api）
│  ├─ settings-host.mjs  # 设置页 Host 桥（inject=['webServer']）+ /api/dsh-pixmax-workflow/*
│  ├─ credentials.mjs    # DSH 凭据中心 + 环境变量；凭据名前缀 PIXMAX_WORKFLOW_IMAGE_*
│  ├─ pixmax-tools.mjs   # 注册 pixmax 工具；81 个 action + skill_install + guard + 报错引导
│  ├─ video-tools.mjs    # 注册 video_probe / frames / scenes / sheet
│  ├─ video-frames.mjs   # 无 ffmpeg 时 Chrome 回退（回环 HTTP + canvas 截帧）
│  ├─ ffmpeg.mjs         # ffmpeg 二进制探测 + spawn 包装
│  ├─ bridge.mjs         # DSH Browser Control HTTP 客户端
│  ├─ chatgpt.mjs        # ChatGPT 网页驱动（generateImage；sendPrompt 已随 chat-tools 删除）
│  ├─ job-runner.mjs     # background=true 的 DSH ctx.jobs 包装
│  └─ store.mjs          # 路径（<root>/images、conversations）、settings.json
└─ .state/tmp/           # 测试脚本（gitignore，不入 git）
   └─ smoke.mjs          # 77 项自动检查，全部通过
```

**已删除**：`src/chat-tools.mjs`（gpt_ask / gpt_last）、`bin/gpt.mjs`、`bin/gpt.cmd`。ChatGPT 网页对话工具与独立 CLI 均已移除。

**gitignore 的私有材料**：`skills/`、`__*`、`.state/`、`conversations/`、`images/`、`video-frames/`、`node_modules/`、`*.log`。仓库不包含任何技能文件。

---

## 三、工具清单（7 个）

### image-tools

| 工具 | 参数（必填加粗） | 返回 |
|------|-----------------|------|
| `model_list` | — | 默认模型 + 每个 model 的 id/类型/端点/key 状态 |
| `image_generation` | **prompt**、model、ref[]、out、size、format(png/jpeg/webp)、watermark、timeout、background | 图片绝对路径、model、channel、宽高 |

- `model` 取值：`browser/gpt-image-2`（ChatGPT 网页）或任意 `provider/modelid`（OpenAI Images 兼容）
- 不传 `model` → 用设置页的默认模型
- `background: true` → 立即返回 `{ status:'running', job_id }`，后台生成

### video-tools

| 工具 | 参数 | 返回 |
|------|------|------|
| `video_probe` | **path** | duration、width/height、fps、codec、backend |
| `video_frames` | **path**、every/times/frames 三选一、from、to、max_frames(默认12)、width、quality、out、attach、backend | 帧文件路径 + 元数据，附加到会话 |
| `video_scenes` | **path**、threshold、max_scenes、from、to | 镜头切点列表（ffmpeg） |
| `video_sheet` | **path**、fps、cover、columns、rows、width、out、attach | 总览图，附加到会话 |

### pixmax-tools

单一工具 `pixmax`，两种调用：

```text
# ① action 简写（81 个，详见 README）
pixmax action="node_get" selector="<uuid>"
pixmax action="node_create" selector="EP2-1组" type="GENERATE_VIDEO" prompt="..." dry_run=false

# ② command 直通
pixmax command=["node","get","EP2-1组"]
```

公共参数：selector、items[]、prompt、model、set[]、left_set[]、dry_run(默认 true)、file、project、out、data、plan_file、timeout…

**硬拦截**：`--run`/`--submit`/`--execute`/`--live` 一律拒绝；`tasks submit-batch`/`group run` 直接拒绝；`video generate-final` 仅允许带 `--dry-run`；`raw` 仅 GET；`repl` 拒绝。

**skill_install**：`pixmax action="skill_install" out="<skills 根目录>"` 把 CLI 自带的 SKILL.md + references 复制进 DSH skills 目录。默认目标 `~/.dsh/skills/pixmax-cli/`。

**面向模型的报错引导（本次新增）**：

| 触发条件 | 返回 |
|----------|------|
| CLI 主目录不存在 / 安装不完整 / spawn 失败 / launcher 不在 PATH | `ok:false` + `hint`：**完整的安装 → 登录 → 环境变量 → 验证步骤**（install.ps1 / install.sh、`PIXMAX_CLI_HOME`、`pixmaxHome`、`auth login`、`PIXMAX_BEARER_TOKEN`、`PIXMAX_ENV`、`doctor`/`auth_whoami`） |
| 参数/用法错误：缺参、未知 action、非法 flag、被拦截的提交命令、CLI 自身 argparse 报错 | `ok:false` + `hint`：**提示先查阅 `pixmax-cli` 技能**（`~/.dsh/skills/pixmax-cli/SKILL.md` + references），并给出 `skill_install` / `skill_show` / `skill_prompt` 等落地手段 |

实现要点：`src/pixmax-tools.mjs` 用 `UsageError` / `CliMissingError` 分类，`execute` 的 catch 按类型挂 `hint`；`output.schema` 增加 `hint` 字段，`render` 以 `[操作引导]` 段显示，因此 CLI 返回 JSON 错误时提示也不会被吞掉。顺带修掉 `parameters.properties.name` 的重复键（原本后一个描述覆盖了「项目文件/目录名」）与 `canvas_node` 的 `args.command_name || args.command_name` 笔误。

---

## 四、设置页

**Settings → 插件 → Pixmax Workflow**（`pixmax-workflow-settings` 辅助行默认启用）

- 浏览器渠道固定为 `browser/gpt-image-2`，其他 OpenAI 兼容端点按 `provider/modelid` 添加
- 内置模型（3 个）：`browser/gpt-image-2`、`sensenova/sensenova-u1.5-lite`、`sensenova/sensenova-u1.5-fast`
- 每个端点保存/删除 API key（写入 DSH 凭据中心，凭据名前缀 `PIXMAX_WORKFLOW_IMAGE_*`）
- 页面只显示"是否已配置 + 来源"，**永远不显示值**
- 存储路径：模型列表 `<root>/settings.json`，key 在凭据中心

**HTTP 桥**（仅同源请求接受）：

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/dsh-pixmax-workflow/state` | GET | 读取当前模型列表 + key 状态 |
| `/api/dsh-pixmax-workflow/save` | POST | 保存模型列表（校验 id 格式、去重、必填字段） |
| `/api/dsh-pixmax-workflow/key` | POST | `{ action: 'set'|'clear', modelId, value }` |
| `/api/dsh-pixmax-workflow/health` | GET | 健康检查 |

---

## 五、Pixmax CLI 安装与配置

工具依赖本机已装好的 Pixmax CLI（`~/.pixmax-cli`，含 launcher / runtime / config.json）。插件不打包、不自动安装 CLI。**本机已安装**（`~/.pixmax-cli` 存在，runtime 可用），但 `~/.dsh/skills/` 里目前只有 `qmk-build`，`pixmax-cli` 技能尚未装。

### 安装

1. 拿到 CLI 包（Pixmax 官方渠道提供的 zip）
2. 运行包里的安装脚本：
   - Windows：`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`
   - macOS/Linux：`bash scripts/install.sh`
3. 默认装到 `~/.pixmax-cli`；换位置设环境变量 `PIXMAX_CLI_HOME` 或插件配置 `pixmaxHome`
4. 安装器写好 `launcher-config.json`（含 `installedPython`、channel、manifest URL、公钥）

### 登录（三选一）

- 浏览器登录：`pixmax auth login web`
- token 登录：`pixmax auth login token <TOKEN>`
- 环境变量：`PIXMAX_BEARER_TOKEN`（优先级最高）

### 环境选择

`PIXMAX_ENV=cn` 或 `global`（默认 cn）。

### 验证

```text
pixmax action="doctor"                  # 本地自检
pixmax action="doctor" online=true      # 联网校验（不花积分）
pixmax action="auth_whoami"             # 当前账号
pixmax action="auth_credit"             # 剩余额度
pixmax action="update_status"           # CLI 是否有更新
```

### 常见问题

- **启动器卡在 Runtime 下载**：工具已绕过（直接调 `runtime/current.json` 指向的 `entry.py`）。手动修：`update_retry` / `update_repair`
- **CLI 没装 / 装坏**：工具在 spawn 之前检查主目录与 `launcher-config.json` / `runtime/current.json`，返回带完整安装步骤的 `hint`，不再只给一句 ENOENT
- **token 失效**：重新 `auth login` 或更新 `PIXMAX_BEARER_TOKEN`
- **参数写错**：返回 `hint` 提示查 `pixmax-cli` 技能，别重复猜参数

### 安装 CLI skill

```text
pixmax action="skill_install"                       # 装到 ~/.dsh/skills/pixmax-cli/
pixmax action="skill_install" out="D:/proj/.dsh/skills"   # 装到项目级技能目录
```

装好后重启 DSH，会话里即可看到 `pixmax-cli` 技能。

---

## 六、安装插件

从 GitHub 安装到桌面版 profile（**已执行**）：

```powershell
dsh plugin --profile desktop add github:bvbhu/dsh-pixmax-workflow
# pnpm 会把依赖写进 desktop/package.json，并自动把 "dsh-pixmax-workflow" 加进 dsh.profile.bundles
# 重启 DSH 后生效
```

本次安装的实际结果：

- `~/.dsh/profiles/desktop/package.json` → `"dsh-pixmax-workflow": "git+https://github.com/bvbhu/dsh-pixmax-workflow.git"`（v0.3.0）
- `dsh.profile.bundles` 末尾已自动加入 `"dsh-pixmax-workflow"`
- `~/.dsh/profiles/desktop/node_modules/dsh-pixmax-workflow/` 含 `src/`、`client/`、`locale/`、`cordis.patch.yml`、`icon.svg`、`README.md`，并已包含本次新增的报错引导代码
- **需要重启 DSH** 才能加载新 bundle

本地开发也可链接目录：`dsh plugin --profile <profile> add link:D:/projects/dsh-pixmax-workflow`；CLI 安装被拒时用 DSH 插件页/管理器安装同一目录或压缩包。

**启用子组件**：在 DSH 设置界面分别开关四个条目；三个工具行默认关，预设默认开且自带工具副本，其他预设里默认没有这些工具。

---

## 七、验证状态

| 检查项 | 结果 |
|--------|------|
| `node --check`（所有 .mjs/.js） | ✅ 0 失败 |
| 自动检查（`.state/tmp/smoke.mjs`） | ✅ **77/77 通过** |
| 语法（client/pixmax-workflow-settings.js） | ✅ |
| 代码内旧命名残留（shotflow / ShotFlow） | ✅ 零残留（仅文档里的历史说明保留旧仓库名） |
| 远程仓库改名 + 推送 | ✅ `bvbhu/dsh-pixmax-workflow`，main 与 origin/main 同步 |
| 从 GitHub 安装到 desktop | ✅ 依赖 + bundles 均已登记 |

smoke.mjs 覆盖：

- 模型注册表：内置默认、保存/读取/去重、key 状态、浏览器无需 key
- 设置页桥：GET/POST/save/key/health、跨站 403、方法 405、浏览器 key 拒绝
- pixmax guard：9 类应拒、7 类应放行、抛 `UsageError`
- **报错引导（本次新增 7 项）**：缺参 / 未知 action / 拦截命令 / 无 action 均带技能提示；CLI 主目录缺失返回安装+登录引导；`render` 显示 `[操作引导]`
- `skill_install`：本机 CLI 已装时按成功路径断言，CLI 缺失时按"返回安装引导"断言（双分支，不再依赖本机是否装 CLI）
- 工具注册：7 个工具（model_list、image_generation、pixmax、video_probe、video_frames、video_scenes、video_sheet）
- 设置页卡片：桥前缀、slot key、client 源检查

---

## 八、设计决策与已知限制

### 设计取舍

- 浏览器渠道走 DSH-Browser-Control 扩展 + 桥接，优先复用已打开的 chatgpt.com 标签页（避免新标签页被 Cloudflare 拦截），所有浏览器调用串行
- 生图按模型 id 分派：browser/* 走网页，其他走 OpenAI 兼容端点；两者复用同一套 background / 保存 / 附加逻辑
- 模型列表与 key 分开存放（模型是用户数据，key 是秘密）
- 视频主后端是 ffmpeg；Chrome 回退只用于没有 ffmpeg 的应急
- Pixmax 暴露所有零积分操作，但提交生成做成硬拦截；规划类命令默认 --dry-run
- 四个条目独立开关，预设只组合工具，不带 persona、不绑定平台
- 后台任务走 DSH ctx.jobs，完成后用 job_output 取结果
- **报错按"模型能不能自救"分类**：CLI 缺失给安装/配置流程，用法错误指向技能文档，而不是把原始 stderr 丢给模型

### 已知限制

- **浏览器渠道分钟级延迟**；可能被 Cloudflare 拦（与浏览器指纹/IP 相关）
- **Pixmax 工具依赖本机 CLI**（不自动安装）；tasks_wait 可能长时间阻塞（默认 120s，最大 600s）
- **设置页 key 写入的是 DSH 凭据中心**；环境变量存在时拒绝写入
- **真实 DSH 会话的端到端验证尚未完成**：插件已装到 desktop profile，但设置页卡片、浏览器渠道生图、Pixmax 真机命令与 `skill_install` 落盘，要重启 DSH 后由使用者跑真实任务确认；smoke.mjs 只覆盖逻辑单元
- **本机 CLI 已可 spawn Python**：早期会话里"EPERM 无法启动 Python"的限制已解除，`skill files` / `skill_install` 在 smoke 中走的是真实 CLI 成功路径；但 DSH 会话内的表现仍未验证
- **skill_install 需要 Pixmax CLI 已安装**；CLI 返回的 skill root 为空/不存在时报可读错误并给安装引导

---

## 九、真机测试清单（重启 DSH 后执行）

1. 新建会话选 **「AI 视频工作流」** 预设，确认 `model_list` / `image_generation` / `pixmax` / `video_*` 工具都在
2. **参数错误引导**：故意调 `pixmax action="node_get"`（缺 selector），确认返回里有「查阅 pixmax-cli 技能」提示
3. **CLI 缺失引导**：临时把 pixmaxHome 指到不存在目录再调 `pixmax action="doctor"`，确认返回安装/登录步骤
4. **skill_install**：跑 `pixmax action="skill_install"`，确认 `~/.dsh/skills/pixmax-cli/` 落盘且重启后 DSH 能发现技能
5. **设置页卡片**：Settings → 插件 → Pixmax Workflow，确认模型列表与 key 状态可见、保存可用
6. **浏览器渠道生图**：`image_generation` 走 `browser/gpt-image-2`，确认出图；端点渠道用任一 OpenAI 兼容模型验证
7. **视频工具**：给一段本地视频跑 `video_probe` / `video_frames` / `video_sheet`
8. **四个条目开关**：在 DSH 插件页分别开关三个工具行与预设，确认互不影响

可选优化：设置页卡片加"测试连接"按钮（调 provider models list 验证 key）；Pixmax 增加批量节点创建的 action 简写。

---

## 十、Git 历史

```
a93a0e3 feat(pixmax): 报错引导（CLI 安装配置 / 查阅 skill）+ 四条目清单与 GitHub 安装说明
c5334cb chore: 移除残留 bin/gpt.cmd
9ffec5a docs: 项目交接文档（dsh-pixmax-workflow 重命名与清理）
f709b83 refactor!: 更名 dsh-pixmax-workflow；移除 gpt-chat 与 gpt CLI；Pixmax 增加 skill_install
4904f44 refactor!: gpt-tools 拆成 gpt-chat 与 image-tools；工具改名 model_list / image_generation
a657b94 feat(image): 生图模型设置页 + 模型列表工具 image_model_list；pixmax 覆盖全部零积分操作
eb9c143 feat: 复用 ChatGPT 标签页、SenseNova 生图渠道、Pixmax 只读工具与凭据中心
fd203d7 refactor!: 项目更名为 ShotFlow（dsh-shotflow），预设改为只装工具的 AI 视频工作流
```

**已推送到远程**：`origin/main` 与 `main` 同步（`eb9c143..a93a0e3` 一次推送完成）。远程仓库已由 `bvbhu/dsh-shotflow` 改名为 `bvbhu/dsh-pixmax-workflow`，旧 URL 由 GitHub 自动重定向。另有 `legacy-history` 分支未包含新改动。

---

## 附：关键文件行数

```
src/image-tools.mjs       ~320 行  # model_list + image_generation
src/image-models.mjs      ~218 行  # 模型注册表
src/image-api.mjs         ~252 行  # OpenAI Images 兼容端点
src/settings-host.mjs     ~223 行  # 设置页 HTTP 桥
src/credentials.mjs       ~180 行  # 凭据中心（前缀 PIXMAX_WORKFLOW_IMAGE_*）
src/pixmax-tools.mjs      ~790 行  # 81 个 action + skill_install + guard + 报错引导
src/video-tools.mjs       ~450 行  # video_probe / frames / scenes / sheet
src/ffmpeg.mjs            ~200 行  # ffmpeg 探测与 spawn
client/pixmax-workflow-settings.js  ~460 行  # 设置页卡片
README.md                 ~445 行  # 完整文档
cordis.patch.yml          ~120 行  # 四条目 + 辅助行
```
