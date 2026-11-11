# 项目交接文档 — dsh-pixmax-workflow

> 生成时间：2026-11-11 19:16 CST
> 仓库：`D:\projects\AICD`（git repo，无 remote）
> 最新提交：`f709b83` refactor!: 更名 dsh-pixmax-workflow；移除 gpt-chat 与 gpt CLI；Pixmax 增加 skill_install
> 分支：main（默认）

---

## 一、项目定位

DSH 插件 bundle（本地开发，未发布 npm）。为 AI 视频生成工作流提供三类工具 + 一个设置页 + 一个只装工具的预设。

三个**子组件**各自独立成行，允许单独开关：

| 子组件 | 条目 id | 包路径 | 工具 |
|--------|---------|--------|------|
| 图像工具 | `image-tools` | `dsh-pixmax-workflow/image` | `model_list`、`image_generation` |
| 视频工具 | `video-tools` | `dsh-pixmax-workflow/video` | `video_probe`、`video_frames`、`video_scenes`、`video_sheet` |
| Pixmax | `pixmax-tools` | `dsh-pixmax-workflow/pixmax` | `pixmax`（81 个 action + `command` 直通） |
| 设置页 | `pixmax-workflow-settings` | `dsh-pixmax-workflow/settings` | 无工具，只注册 HTTP 桥 + 插件页卡片 |

「AI 视频工作流」预设（`preset-ai-video-workflow`）只组合上面这些工具与基础文件/命令/任务能力，不带自定义 persona、不绑定平台、不依赖技能文件。

---

## 二、目录结构

```
D:\projects\AICD\
├─ package.json          # dsh-pixmax-workflow 0.3.0；main → ./src/image-tools.mjs
├─ cordis.patch.yml      # 三行工具行（默认关，独立开关）+ 设置页行（默认开）+ 预设
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
│  ├─ pixmax-tools.mjs   # 注册 pixmax 工具；81 个 action + skill_install
│  ├─ video-tools.mjs    # 注册 video_probe / frames / scenes / sheet
│  ├─ video-frames.mjs   # 无 ffmpeg 时 Chrome 回退（回环 HTTP + canvas 截帧）
│  ├─ ffmpeg.mjs         # ffmpeg 二进制探测 + spawn 包装
│  ├─ bridge.mjs         # DSH Browser Control HTTP 客户端
│  ├─ chatgpt.mjs        # ChatGPT 网页驱动（generateImage；sendPrompt 已随 chat-tools 删除）
│  ├─ job-runner.mjs     # background=true 的 DSH ctx.jobs 包装
│  └─ store.mjs          # 路径（<root>/images、conversations）、settings.json
└─ .state/tmp/           # 测试脚本（不入 git）
   └─ smoke.mjs          # 70 项自动检查，全部通过
```

**已删除**：`src/chat-tools.mjs`（gpt_ask / gpt_last）、`bin/gpt.mjs`、`gpt.cmd`。ChatGPT 网页对话工具与独立 CLI 均已移除。

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

---

## 四、设置页

**Settings → 插件 → Pixmax Workflow**（`pixmax-workflow-settings` 行默认启用）

- 浏览器渠道固定为 `browser/gpt-image-2`，其他 OpenAI 兼容端点按 `provider/modelid` 添加
- 内置模型（3 个）：`browser/gpt-image-2`、`sensenova/sensenova-u1.5-lite`、`sensenova/sensenova-u1.5-fast`
- 每个端点保存/删除 API key（写入 DSH 凭据中心，凭据名前缀 `PIXMAX_WORKFLOW_IMAGE_`）
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

工具依赖本机已装好的 Pixmax CLI（`~/.pixmax-cli`，含 launcher / runtime / config.json）。插件不打包、不自动安装 CLI。

### 安装

1. 拿到 CLI 包（Pixmax 官方渠道提供的 zip）
2. 运行包里的安装脚本：
   - Windows：`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`
   - macOS/Linux：`bash scripts/install.sh`
3. 默认装到 `~/.pixmax-cli`；换位置设环境变量 `PIXMAX_CLI_HOME`
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
- **CLI 没装**：工具返回可读错误；检查 `PIXMAX_CLI_HOME`
- **token 失效**：重新 `auth login` 或更新 `PIXMAX_BEARER_TOKEN`

### 安装 CLI skill

```text
pixmax action="skill_install"                       # 装到 ~/.dsh/skills/pixmax-cli/
pixmax action="skill_install" out="D:/proj/.dsh/skills"   # 装到项目级技能目录
```

装好后重启 DSH，会话里即可看到 `pixmax-cli` 技能。

---

## 六、安装插件

```powershell
dsh plugin --profile <profile> add link:D:/projects/AICD
# 把 "dsh-pixmax-workflow" 加入 dsh.profile.bundles（dsh plugin add 通常会自动加）
# 重启 DSH 后生效
```

桌面版 profile 由 Electron 应用管理；CLI 安装被拒时用 DSH 插件页/管理器安装同一目录或压缩包。

**启用子组件**：在 DSH 设置界面（Settings → Plugins）分别开关 `image-tools`、`video-tools`、`pixmax-tools`；或写进目标预设的 plugins 列表。

---

## 七、验证状态

| 检查项 | 结果 |
|--------|------|
| `node --check`（所有 .mjs/.js） | ✅ 全绿 |
| 自动检查（`.state/tmp/smoke.mjs`） | ✅ 70/70 通过 |
| 语法（client/pixmax-workflow-settings.js） | ✅ |
| 命名冲突（dsh-shotflow / shotflow / ShotFlow） | ✅ 零残留 |

smoke.mjs 覆盖：

- 模型注册表：内置默认、保存/读取/去重、key 状态、浏览器无需 key
- 设置页桥：GET/POST/save/key/health、跨站 403、方法 405、浏览器 key 拒绝
- pixmax guard：9 类应拒、7 类应放行、skill_install 路径错误时拒绝
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
- 预设只组合工具，不带 persona、不绑定平台
- 后台任务走 DSH ctx.jobs，完成后用 job_output 取结果

### 已知限制

- **浏览器渠道分钟级延迟**；可能被 Cloudflare 拦（与浏览器指纹/IP 相关）
- **Pixmax 工具依赖本机 CLI**（不自动安装）；tasks_wait 可能长时间阻塞（默认 120s，最大 600s）
- **设置页 key 写入的是 DSH 凭据中心**；环境变量存在时拒绝写入
- **没有真实 DSH 实例验证**：本会话沙箱限制（EPERM）导致无法 spawn Python 做端到端测试；smoke.mjs 覆盖了全部逻辑单元，但 webServer.register / slots 注册在真机上的表现还需一次安装后人工确认
- **skill_install 需要 Pixmax CLI 已安装**；如果 skill_files 返回空 root 会报可读错误

---

## 九、下一步建议

1. **真机验证**：装到 desktop profile（或 web profile），确认设置页卡片正常、Pixmax CLI 命令真实跑通、image_generation 浏览器渠道正常
2. **skill_install 真机验证**：跑 `pixmax action="skill_install"`，确认 DSH 能发现 `pixmax-cli` 技能
3. **README 审阅**：目录结构、运行时序图、Pixmax 安装与 skill 章节
4. **可选优化**：给设置页卡片加"测试连接"按钮（调 provider 的 models list 端点验证 key）；Pixmax 工具增加批量节点创建的 action 简写

---

## 十、Git 历史

```
f709b83 refactor!: 更名 dsh-pixmax-workflow；移除 gpt-chat 与 gpt CLI；Pixmax 增加 skill_install
4904f44 refactor!: gpt-tools 拆成 gpt-chat 与 image-tools；工具改名 model_list / image_generation
a657b94  feat(image): 生图模型设置页 + 模型列表工具 image_model_list；pixmax 覆盖全部零积分操作
eb9c143  feat: 复用 ChatGPT 标签页、SenseNova 生图渠道、Pixmax 只读工具与凭据中心
fd203d7  refactor!: 项目更名为 ShotFlow（dsh-shotflow），预设改为只装工具的 AI 视频工作流
```

**未推送到远程**（仓库无 remote）。

---

## 附：关键文件行数

```
src/image-tools.mjs       ~320 行  # model_list + image_generation
src/image-models.mjs      ~218 行  # 模型注册表
src/image-api.mjs         ~252 行  # OpenAI Images 兼容端点
src/settings-host.mjs     ~223 行  # 设置页 HTTP 桥
src/credentials.mjs       ~180 行  # 凭据中心（前缀 PIXMAX_WORKFLOW_IMAGE_*）
src/pixmax-tools.mjs      ~700 行  # 81 个 action + skill_install + guard
src/video-tools.mjs       ~450 行  # video_probe / frames / scenes / sheet
src/ffmpeg.mjs            ~200 行  # ffmpeg 探测与 spawn
client/pixmax-workflow-settings.js  ~460 行  # 设置页卡片
README.md                 ~420 行  # 完整文档
```
