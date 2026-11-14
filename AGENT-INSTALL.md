# 飞书远程会话桥 · 安装手册

> 这份文档写给**执行安装的 AI Agent**，人照着做也完全一样。
> 全文没有需要你判断的地方，每一步都有「怎么做」和「怎么确认做对了」。
> 遇到对不上的现象，直接跳第 7 节排障表，不要即兴改代码。

---

## 0. 三十秒速览

**这套东西干什么**：在家里的 Windows 电脑上常驻一个小进程。一个飞书私聊列出本机的 Claude Code、Codex 和 DeepSeek 会话。打开一条后发一句话，电脑上那个会话接着干，干完结果自动推回飞书。

**不需要**：公网 IP、端口映射、内网穿透、服务器。全程是电脑主动往外连飞书的长连接。

**装好的判据**：飞书里私聊机器人发 `hi`，它回一张「全部会话」卡片。顶部有「全部 / Claude / Codex / DeepSeek」。点开任意一条，能看到最近的对话记录。

**总步数**：体检 → 一键安装 → 飞书后台配四项 → 发布 → 验收。熟练的话 15 分钟。

---

## 1. 前置条件

逐条核对，缺哪条先补哪条，别硬装。

| # | 要求 | 自检 | 不满足怎么办 |
|---|---|---|---|
| 1 | Windows 10 / 11 | `ver` | 本包只做了 Windows 版。macOS 能跑但「停止」「开机自启」两处要自己改，见 9.2 |
| 2 | Node.js ≥ 20.6 | `runtime\node.exe -v` | **本包已内置 v24.12.0**，正常不用管。只有当 `runtime\node.exe` 丢了才需要自己装 |
| 3 | Claude Code CLI ≥ 2.x | `claude --version` | `npm i -g @anthropic-ai/claude-code`，装完重启终端 |
| 4 | 本机**至少跑过一个** Claude 会话 | `dir "%USERPROFILE%\.claude\projects"` 有子目录 | 先用 VS Code 插件或终端随便开个会话聊两句，否则列表里没有 Claude。Codex、DeepSeek 不是安装前提：有对应目录才会多出那些行 |
| 5 | 飞书**企业/团队**账号 | — | 个人版飞书无法创建自建应用，这条路走不通。公司/团队账号才行 |
| 6 | 有权限创建应用并发布 | — | 没有的话找管理员要权限，或让管理员代建 |

> 第 3、4 条最容易漏。`claude --version` 出不了版本号，后面所有功能都会静默失效。

---

## 2. 解压与目录

解压到**纯英文、无空格**的路径，推荐 `D:\agent-bridge`。中文路径大多数情况没事，但 VBS 自启脚本和部分命令行工具会出幺蛾子，不值得赌。

```
agent-bridge\
├─ install.cmd          ← 一键安装（双击）
├─ check.cmd            ← 体检，随时跑：一条命令告诉你卡在哪
├─ start.cmd            ← 前台启动，能看见日志（调试用）
├─ stop.cmd             ← 停止守护进程
├─ AGENT-INSTALL.md     ← 你正在看的这份
├─ README.md            ← 项目背景与设计取舍
├─ .env.example         ← 凭证模板
├─ runtime\node.exe     ← 内置 Node v24，解压即用
├─ node_modules\        ← 依赖已装好，不需要 npm install
├─ src\                 ← 主程序
│   ├─ index.mjs        守护进程（会话路由 + 卡片交互）
│   ├─ cards.mjs        飞书卡片渲染
│   ├─ platforms.mjs    多编辑器登记表（Claude 可写，其余已接入的只读）
│   ├─ channels\feishu.mjs   长连接收发
│   └─ core\            Claude / Codex / DeepSeek 会话读取与续跑、runner、patrol
├─ tools\
│   ├─ setup-win.mjs    安装脚本本体
│   ├─ doctor.mjs       体检工具
│   └─ watchdog.mjs     看门狗，守护进程挂了自己拉起来
├─ docs\MODE-SWITCH.md  手机↔电脑会话交接的设计文档（想改逻辑先读它）
├─ .docs\               飞书卡片 JSON 结构速查（想改卡片先读它）
└─ data\                运行期数据，首次启动自动生成，**不要提交/外传**
```

`data\` 里会长出：`state.json`（绑定关系、所有者）、`bridge.lock`（PID 锁）、`bridge.log`（日志）、`uploads\`（手机发来的图片）。

---

## 3. 一键安装

### 3.1 双击 `install.cmd`

会依次问你四件事：

| 步骤 | 它会做什么 | 你要做的 |
|---|---|---|
| 一、体检 | 检查 Node / Claude CLI / 会话目录 | 看有没有标 `×` 的，有就先解决再重跑 |
| 二、凭证 | 交互输入飞书 App ID 和 App Secret | 从开发者后台复制粘贴，Secret 输入时显示 `*` |
| 三、自启 | 往「启动」文件夹写一个静默 VBS | 回车同意即可 |
| 四、启动 | 拉起看门狗（守护进程由它拉起） | 回车同意 |

**凭证从哪来**：<https://open.feishu.cn/app> → 你的应用 →「基础信息」→「凭证与基础信息」。App ID 形如 `cli_a1b2c3d4e5f6g7h8`，App Secret 是一串 32 位字符。

### 3.2 Agent 无终端环境下的等价操作

如果没法开交互终端（CI、远程 agent、批处理），手动做同样的事：

```bat
cd /d D:\agent-bridge
copy .env.example .env
```

然后用编辑器把 `.env` 改成正这样（**不要加引号、不要留空格**）：

```
FEISHU_APP_ID=cli_你的真实id
FEISHU_APP_SECRET=你的真实secret
```

接着装自启：在 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` 新建 `ClaudeBridgeWatchdog.vbs`，内容（路径换成实际的）：

```vbscript
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "D:\agent-bridge"
shell.Run """D:\agent-bridge\runtime\node.exe"" tools\watchdog.mjs", 0, False
```

最后启动：双击 `start.cmd`（前台，能看日志），或者直接跑 `runtime\node.exe tools\watchdog.mjs`。

### 3.3 启动成功的标志

日志里出现这两行就对了：

```
已启动：Claude 37 个，Codex 5 个，DeepSeek 6 个，等待飞书消息…
[info]: [ '[ws]', 'ws client ready' ]
```

这三个数字分别是 Claude、Codex、DeepSeek 的会话数，对不上示例也正常。本机没有的那一项是 0。**只有「已启动」没有「client ready」，说明凭证错或网络出不去——长连接没建起来。**

不想翻日志就双击 `check.cmd`，它会逐项告诉你哪一项过了、哪一项没过，以及怎么修：

```
运行时      ✓ Node 24.12.0
            ✓ Claude Code CLI  C:\Users\...\claude.exe
凭证        ✓ FEISHU_APP_ID  cli_a1b2c3d4e5…
            ✓ FEISHU_APP_SECRET  已填写
会话数据    ✓ 37 个 Claude 会话
守护进程    ✓ 运行中  PID 10824
飞书长连接  ✓ 日志里有 ws client ready
开机自启    ✓ 已安装
```

装完、出问题、改完配置，都先跑它。退出码 0 = 全过，1 = 有硬伤。`check.cmd` 的「会话数据」只数 Claude；另外四个平台的条数看启动日志，以及飞书里的「全部会话」卡片。

---

## 4. 飞书开放平台配置

### ⚠️ 顺序是有讲究的，别打乱

**必须先让守护进程跑起来，再去后台改「订阅方式」。**
飞书后台保存「使用长连接接收事件」时，会检查应用当前有没有在线长连接——本地没连上，这个选项根本存不住。这就是最多人卡住的地方。

所以：第 3 节跑完、看到 `ws client ready` 之后，再往下做。

### 4.1 创建应用

<https://open.feishu.cn/app> → 创建企业自建应用。
**必须是「企业自建应用」，「商店应用」不支持长连接。**

### 4.2 加机器人能力

「应用能力」→「添加应用能力」→ 添加 **机器人**。

### 4.3 开权限

「开发配置」→「权限管理」，搜索并开通：

**必需（少一个就跑不起来）**

| 权限 | 作用 |
|---|---|
| `im:message.p2p_msg:readonly` | 读单聊里用户发给机器人的消息 |
| `im:message:send_as_bot` | 以应用身份发消息、发卡片 |
| `im:message.group_at_msg:readonly` | 读群里 @机器人 的消息 |

**可选（缺了只是对应小功能失效，不影响主流程）**

| 权限 | 作用 | 缺了的表现 |
|---|---|---|
| 消息资源读取（`im:message.resource:read`） | 下载手机发来的图片/文件 | 发图提示「附件没下载下来」 |
| 上传图片/文件（`im:resource`） | 把图片回显到卡片里 | 卡片里图裂 |
| 表情回复（`im:message.reaction`） | 收到消息先回个 ✅ | 无回执，但功能正常 |
| 消息置顶（`im:message.pin`） | 把控制台卡片钉在会话顶部 | 卡片会被聊天刷上去 |
| 撤回消息（`im:message:recall`） | `/clean on` 后撤回群消息 | 群里留一堆输入记录 |
| 加急（`im:message.urgent`） | 回合结束时弹窗提醒 | 只是不响铃 |

在权限管理里搜 `im:` 前缀，把跟「消息」相关的读/写权限都勾上最省事。

### 4.4 事件订阅

「开发配置」→「事件与回调」→「事件配置」：

1. 订阅方式选 **「使用长连接接收事件」** → 保存
2. 点「添加事件」，搜索并添加 **接收消息 `im.message.receive_v1`**

### 4.5 卡片回调

同一页面下半部分「回调配置」：

1. 订阅方式同样选 **「使用长连接接收回调」** → 保存
2. 添加回调 **卡片回传交互 `card.action.trigger`**

> 漏了这步的典型症状：卡片能收到、按钮能点，但点了转圈没反应。文字命令仍然可用。

### 4.6 发布

「应用发布」→「版本管理与发布」→ 创建版本 → 申请发布。
自己是管理员的话直接审核通过；不是的话等管理员点同意。**权限和事件改完必须重新发版才生效。**

### 4.7 找到机器人

飞书客户端搜索应用名称 → 打开单聊 → 发 `hi`。

想用群聊：把机器人拉进群，在群里 **@机器人** 再说话（不 @ 收不到，这是 4.3 里那个 `group_at_msg` 权限的限制）。

---

## 5. 验收清单

**先双击 `check.cmd`，确认没有 `×`。** 它只能验证本机这一侧；下面五项是手机上的真实验证，替代不了。

五项全过才算装完。任何一项失败，看右列。

| # | 操作 | 期望 | 失败看 |
|---|---|---|---|
| 1 | 飞书私聊发 `hi` | 回一张「全部会话」卡片，顶部能切 Claude / Codex / DeepSeek | 7.1 7.3 |
| 2 | 发 `列表` | 同一张总表：标题、来源、项目、最后活跃时间 | 7.5 |
| 3 | 点任意会话的「查看」 | 出现会话详情，能看到最近对话 | 7.6 |
| 4 | 打开一条会话后发 `你好` | 手机先回 ✅，几秒后卡片刷新出回答。Claude、Codex、DeepSeek 都会续跑 | 7.4 7.7 |
| 5 | 发 `/status` | 卡片显示 PID、运行时长、会话数、错误数 | 7.2 |

第 4 项是核心：它证明「飞书 → 本机 claude CLI → JSONL → 飞书」整条回路通了。

---

## 6. 手机端命令速查

| 你说 | 它做什么 |
|---|---|
| 直接发文字 | 送进当前打开的 Claude、Codex 或 DeepSeek 会话；它正在跑就自动排队 |
| `Claude` / `Codex` / `DeepSeek` | 整句匹配时打开那一列会话。飞书机器人菜单选「发送文字消息」，内容就填这个名字 |
| `1` / `2` | 会话忙时选「立即插入」/「排队」 |
| `/now 内容` | 无视忙闲，排到队首 |
| `/queue 内容` | 排队等这一轮结束 |
| `/files` | 列这个会话收到的附件 |
| `/use 3` | 把第 3 个附件重新发给会话 |
| `/drop` | 丢弃还没确认发送的附件 |
| `/find 关键字` | 搜会话（标题/项目/消息内容） |
| `/new` | 选目录新建一个会话 |
| `/open <id>` | 打开指定会话 |
| `/close` | 解绑当前会话 |
| `/status` | 桥自己的运行状态 |
| `/notify on\|off` | 回合结束要不要另发一条摘要 |
| `/clean on\|off` | 群聊里处理完是否撤回你的消息（默认关） |
| `/help` | 帮助卡 |

图片/文件：聊天框「+」选图，可以连发几张再配一句说明，**在确认卡上点「发送」才真正开始读**——点「取消」就当没发过。

---

## 7. 排障

### 7.1 启动就退出，报「已经有守护进程在跑（PID x）」

飞书长连接是集群模式，两个实例会互相抢消息，所以启动了单实例锁。

```bat
stop.cmd
start.cmd
```

还不行就 `taskkill /F /PID <那个PID>`，再删掉 `data\bridge.lock`。

### 7.2 日志没有 `client ready`

| 观察 | 原因 |
|---|---|
| 报 `app_id` / `app_secret` 相关错误 | `.env` 填错，或者带上了引号/空格 |
| 一直重连、无响应 | 公司网络挡了飞书长连接域名，试试换网络或代理 |
| 报权限错误码 `99991663` | 应用没发布，或机器人在企业内不可见 |

### 7.3 后台保存「长连接」失败，或提示未建立连接

本地守护进程没在跑。先 `start.cmd` 看到 `ws client ready`，再回后台保存。

### 7.4 手机发消息完全没反应，日志写「忽略非所有者消息」

第一次发消息的人会被记为唯一所有者，写进 `data\state.json` 的 `ownerOpenId`。换人了就**停掉进程**，删掉 `state.json` 里那一行（或整个文件），重启，让新的第一个人重新认领。

### 7.5 列表是空的

- Claude、Codex、DeepSeek 的会话目录都是空的 → 本机没有可列的会话
- Claude 会话在别处 → 在 `.env` 里加 `CLAUDE_PROJECTS_DIR=实际路径`
- Codex 会话在别处 → 在 `.env` 里加 `CODEX_SESSIONS_DIR=实际路径`
- DeepSeek 会话在别处 → 在 `.env` 里加 `DSH_SESSIONS_DIR=实际路径`
- Codex 程序不在默认位置 → 在 `.env` 里加 `CODEX_BIN=codex.exe 的完整路径`
- DeepSeek 启动器不在默认位置 → 在 `.env` 里加 `DSH_BIN=dsh 可执行文件的完整路径`
- 某一边没有行：本机没有那个工具的会话目录，这是正常的

### 7.6 点开会话报「No conversation found」

`claude --resume` 必须用会话原来的工作目录。程序会先从 JSONL 里读 cwd，读不到再反解项目目录名。仍然失败通常是：那个项目文件夹被改名/删除了。

### 7.7 发消息后没动静，日志报 spawn 失败

`claude` 不在 PATH。在 `.env` 里写死路径：

```
CLAUDE_BIN=C:\Users\你的用户名\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
```

### 7.8 卡片按钮点了转圈

4.5 的 `card.action.trigger` 没配，或者配了没发版。文字命令不受影响，可以先用 `/status`、`/open` 顶着。

### 7.9 群里不回复

没 @机器人，或者机器人没被拉进群（4.7）。

### 7.10 开机后手机没反应

开机自启没装或路径变了。重新跑 `install.cmd`，或者把 VBS 里的 `CurrentDirectory` 改成实际路径。也可以改用任务计划程序：触发器「登录时」，操作 `D:\agent-bridge\runtime\node.exe`，参数 `tools\watchdog.mjs`，起始于 `D:\agent-bridge`。

---

## 8. 安全边界（必须让使用者知道）

1. **手机发的话 = 本机终端里直接执行。** 执行权限是 `bypassPermissions`，不问不拦。这个机器人等于你电脑的远程键盘。
2. **只有一个人能用。** 第一个发消息的人被记为 owner，其他人一律忽略。这是设计，不是 bug。
3. **凭证只在本机。** `.env` 不出这台电脑，代码里没有任何上报。
4. **别拉进公共群。** 群里的任何人在被撤销 owner 之前都能触发执行（当前实现只认第一个人的 open_id，群聊里请自行确认成员可控）。
5. **`data\` 别外传。** 里面有 `ownerOpenId`、聊天 ID、手机发来的图片、会话内容摘要。

---

## 9. 工作原理（给 Agent 建立心智模型）

### 9.1 数据流

```
Claude Code（VS Code 插件 / 终端）
        │ 每个会话追加写入
        ▼
%USERPROFILE%\.claude\projects\<项目编码>\<sessionId>.jsonl
        │ 只读监听，按字节偏移增量解析（800ms 一轮）
        ▼
   TranscriptStore ──► 飞书长连接（出站，不占端口）
        ▲                    │
        │ claude --resume    │ 手机发来的文字
        └──── runner ◄───────┘

Codex
        │ rollout-*.jsonl，同一 session_id 只留最新一份
        ▼
%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl
        │ 读开头和末尾，约 2 秒扫一轮
        ▼
   CodexStore ──► 同一张卡片
        ▲
        │ codex exec resume <会话号>
        └──── runner

DeepSeek Harness（dsh）
        │ session.v4.jsonl.zstd，多段压缩
        ▼
%USERPROFILE%\.dsh\sessions\**\session.v4.jsonl.zstd
        │ 只读解压，约 2 秒扫一轮
        ▼
   DshStore ──► 同一张卡片
        ▲
        │ dsh --profile headless --session-id <会话号>
        └──── runner
```

三条铁律，改 Claude 写回前必须先接受：

1. **文件是唯一真相。** Claude 的上下文永远从 JSONL 重新读，不在内存里攒。
2. **手机消息续聊原会话。** Claude 用 `claude --resume`。Windows 上已在 Codex 桌面端打开的会话由桌面进程接收消息，其余 Codex 会话用 `codex exec resume`。DeepSeek 按会话类型选择无界面续跑或本机 Web 会话服务。
3. **同一 Claude 会话同一时刻只能有一个持有者。** 靠 `~/.claude/sessions/*.json` 里的 PID 探测，电脑端正在用就拒绝手机端发送，只给「强制接管」。

Cursor 和 WorkBuddy 没有可用的续跑命令，不列入这张卡片。

### 9.2 平台差异

主流程 Windows / macOS / Linux 都能跑，但三处是 Windows 专有：

| 位置 | 内容 | macOS 改法 |
|---|---|---|
| `src\index.mjs` `killPid()` | 兜底 `taskkill /F /PID` | 改成 `kill -9` |
| `tools\setup-win.mjs` | 开机自启写 Startup 文件夹 | 改 `~/Library/LaunchAgents` plist |
| `install.cmd` / `start.cmd` | 批处理 | 写 `.sh` |

会话目录编码 `encodeProjectDir()` 的盘符处理只对 Windows 生效，macOS 上会走 JSONL 里记录的 cwd，一般不影响。

---

## 10. 日常运维

| 想干什么 | 怎么做 |
|---|---|
| 体检 | `check.cmd`（或 `runtime\node.exe tools\doctor.mjs`） |
| 看日志 | `data\bridge.log`（守护进程）、`data\watchdog.log`（看门狗） |
| 重启 | `stop.cmd` 然后 `start.cmd`，或让看门狗自己拉 |
| 改配置 | 改 `.env` → `stop.cmd` → `start.cmd` |
| 升级代码 | 停进程 → 覆盖 `src\` 和 `tools\` → 启动。`data\` 保留，绑定关系不丢 |
| 迁移到新电脑 | 整个文件夹拷过去 → 改 `.env` 里的凭证（可复用同一个应用）→ 删 `data\state.json` 重新认领 owner → 重装自启 |
| 彻底卸载 | `install.cmd remove`（删自启+停进程）→ 删整个文件夹 → 飞书后台删应用 |

---

## 附录 A · 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `FEISHU_APP_ID` | ✅ | — | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | — | 飞书应用 App Secret |
| `CLAUDE_BIN` | | 自动探测 | claude 可执行文件完整路径 |
| `CLAUDE_PROJECTS_DIR` | | `~\.claude\projects` | Claude 会话文件目录 |
| `CODEX_SESSIONS_DIR` | | `~\.codex\sessions` | Codex rollout 目录 |
| `DSH_SESSIONS_DIR` | | `~\.dsh\sessions` | DeepSeek Harness 会话目录 |
| `CODEX_BIN` | | 自动找 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` | Codex 可执行文件 |
| `DSH_BIN` | | 自动找 `dsh.cmd` 旁边的 `node` 和 `bin.js` | DeepSeek 启动器。一般不用填 |
| `POLL_MS` | | `800` | 轮询间隔，越小越实时越费 CPU |
| `HISTORY_LIMIT` | | `60` | 每个会话保留的消息条数 |

## 附录 B · 给 Agent 的检查点

每做完一步，必须验证，不要凭感觉推进：

| 完成 | 验证命令 | 通过标准 |
|---|---|---|
| 解压 | `runtime\node.exe -v` | 输出 `v24.x` |
| 体检 | `check.cmd` | 没有 `×` |
| 写凭证 | `type .env` | 两行非空，无引号 |
| 启动 | `type data\bridge.log` | 含 `ws client ready` |
| 配事件 | 后台「事件与回调」 | 显示长连接已连接 |
| 验收 | 飞书发 `hi` | 收到卡片 |

Agent 用命令行跑（不弹 pause）：

```bat
cd /d D:\agent-bridge
runtime\node.exe tools\doctor.mjs
```

退出码 0 表示全过。任何一项 `×`，把对应那行和它下面 `→` 的提示原样转述给用户即可，不需要你现场改代码。

## 附录 C · 术语对照

| 文档里说 | 代码里叫 | 飞书后台叫 |
|---|---|---|
| 会话 | session / sessionId | — |
| 桥 / 守护进程 | daemon（`src\index.mjs`） | — |
| 看门狗 | watchdog（`tools\watchdog.mjs`） | — |
| 持有者 | owner（`~/.claude/sessions`） | — |
| 唯一所有者 | `ownerOpenId` | — |
| 长连接 | WebSocket / WSClient | 使用长连接接收事件 |
| 卡片 | interactive card | 消息卡片 / 卡片回传交互 |
