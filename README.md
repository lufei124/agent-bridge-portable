# agent-bridge

在家里电脑上常驻。一个飞书私聊就能看到本机的 Claude Code、Codex 和 DeepSeek 会话，并接着发消息。做完会推回飞书。

> 便携包自带 Node 和依赖。通过 GitHub 获取源码时，请先安装 Node.js 24 或更新版本并运行 `npm ci`，
> 然后双击 `install.cmd` 配置飞书。
> 完整安装步骤见 **[AGENT-INSTALL.md](AGENT-INSTALL.md)**。

## 原理

Claude Code 把每个会话追加写入 `~/.claude/projects/<项目路径编码>/<sessionId>.jsonl`。
Codex 把会话写在 `~/.codex/sessions/**/rollout-*.jsonl`。
DeepSeek Harness 把会话写在 `~/.dsh/sessions/**/session.v4.jsonl.zstd`。
本程序读这些文件，再通过飞书长连接收发消息——**不改插件、不注入、不开公网端口**。
Windows 上，桥接优先通过 Codex 桌面端的本地命名管道把消息转给持有原会话的桌面进程。没有桌面持有者时，Codex 用 `codex exec resume` 续跑。DeepSeek 的无界面会话继续使用 `dsh --profile headless --session-id`。带桌面端预设的会话通过仅监听本机的 DeepSeek Web 会话服务续跑，保留同一个会话编号、预设和历史。
Codex 里同一个会话编号的多份 rollout 合成一条。大文件只读开头（标题）和末尾（最近对话）。

```
~/.claude/projects/**/*.jsonl ──增量读取──► TranscriptStore ──► 飞书长连接
        ▲                                      │                    │
        │ claude --resume                      │                    │ 手机消息
        └──────── runner ◄─────────────────────┘                    │
                                                                    │
~/.codex/sessions/**/rollout-*.jsonl ──读取──► CodexStore ──► codex exec resume
~/.dsh/sessions/**/session.v4.jsonl.zstd ──读取──► DshStore ──► dsh headless / 本机 Web 会话服务
```

## 快速开始

```
1. 解压到 D:\agent-bridge 这类纯英文路径
2. 双击 install.cmd      （四个交互步骤：体检、填凭证、装自启、启动）
3. 看到日志出现 ws client ready
4. 去 open.feishu.cn 配事件订阅与卡片回调，发布应用
5. 飞书里私聊机器人发 hi
```

第 4 步的顺序很关键：**必须先跑起长连接，再去后台保存「订阅方式」**，否则存不住。详见 AGENT-INSTALL.md 第 4 节。

手工启动 / 调试：

```bat
start.cmd            :: 前台跑，日志打在窗口里
check.cmd            :: 体检，一条命令告诉你卡在哪
stop.cmd             :: 停掉
```

## 飞书配置摘要

1. 创建**企业自建应用**（商店应用不支持长连接）
2. 添加**机器人**能力
3. 开权限：`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message.group_at_msg:readonly`
4. 事件订阅选**长连接**，加 `im.message.receive_v1`
5. 回调配置选**长连接**，加 `card.action.trigger`
6. 创建版本并发布

## 目录

```
src/index.mjs             守护进程：会话路由 + 卡片交互
src/cards.mjs             飞书卡片渲染
src/platforms.mjs         多编辑器登记表（Claude、Codex、DeepSeek 可写）
src/channels/feishu.mjs   长连接收发
src/core/transcript.mjs   监听 + 增量解析 Claude JSONL
src/core/codex.mjs        读取 Codex rollout，合成会话列表
src/core/dsh.mjs          读取 DeepSeek Harness 会话
src/core/normalize.mjs    原始记录 → 与通道无关的事件
src/core/runner.mjs       一条消息 = 一次 claude --resume（仅 Claude）
src/core/patrol.mjs       会话持有者探测（~/.claude/sessions）
src/core/holder.mjs       长驻进程备件，未接主路径
src/cli/list.mjs          会话列表（命令行）
src/cli/watch.mjs         实时流水（命令行调试用）
tools/watchdog.mjs        看门狗，进程挂了自己拉起来
tools/setup-win.mjs       一键安装脚本
```

## 手机端命令

| 发送 | 作用 |
|---|---|
| `hi` / `列表` | 一张卡片列出本机全部会话。顶部可切「全部 / Claude / Codex / DeepSeek」 |
| `Claude` / `Codex` / `DeepSeek` | 直接打开对应那一列。整句匹配，适合填进飞书机器人菜单的「发送文字消息」 |
| `打开 <短ID>` | 把当前飞书对话绑定到某个会话 |
| `/close` | 解绑，回到会话列表 |
| `/new` / `/new claude` / `/new codex` / `/new deepseek` | 选择项目目录，用下一条消息创建会话 |
| `状态` | 查看绑定、运行状态、排队数 |
| 直接发文字 | 送进当前打开的 Claude、Codex 或 DeepSeek 会话。它正在跑就自动排队 |
| `1` / `2` | 会话正忙时选择「立即插入」或「排队」 |
| `/now <文字>` | 无视忙闲，排到队首 |
| `/queue <文字>` | 无视忙闲，排队执行 |
| `/files` `/use N` `/drop` | 附件管理 |
| `/find <关键字>` | 搜索会话 |
| `/notify on\|off` | 回合结束是否另发摘要 |
| `/clean on\|off` | 群聊里是否撤回你发的消息 |

Claude、Codex 和 DeepSeek 的列表都有对应的「新建会话」按钮。选好项目目录后发第一条消息，桥接会在任务完成后打开新会话。续聊已有会话时，先点「查看」再发送。续跑会把结果写回各自的会话文件。

在 Windows 上可以保留 Codex 桌面端原会话，再从飞书发送。桌面端处理这轮消息，并沿用该会话设置。桌面正在运行时，桥接等它空闲后再送入下一轮。桌面端处理的回合可在电脑端停止。桥接通过原会话记录核对完成情况。结果未确认时，请查看原会话，避免重复发送。桌面本地协议可能随 Codex 更新变化。

桥接会让 DeepSeek Harness 无界面模式读取同一 Harness 配置目录里已保存的 API Key。也可以在桥的本地 `.env` 中设置 `DEEPSEEK_API_KEY` 作为备用。

对于原有的 DeepSeek 桌面会话，请在飞书的 DeepSeek 列表打开原会话后发送消息。会话沿用原来的模型与登录方式。电脑端占用原会话时，请先关闭对应会话再重发。桥接使用与桌面端相同的 `DSH_HOME`（默认 `~/.dsh`）。如果原会话服务启动失败，在电脑的命令提示符中运行 `check.cmd --deepseek`。该命令检查会话服务和文件权限，不提交聊天消息。

如果便携 Node 启动 Harness 时遇到 `EPERM web-profile`，在 Windows 安装系统版 Node 后，`start.cmd` 和 `check.cmd --deepseek` 会优先使用系统版。可通过本地 `.env` 的 `BRIDGE_DSH_NODE` 指定运行 DeepSeek CLI 的 Node 路径。

## 会话列表与详情

会话列表卡片的页码和翻页按钮位于同一排，「刷新」在右侧。

点开会话后，第 1 页显示最新的聊天记录，每页最多 10 轮。用数字页码或「上一页」「下一页」翻阅已加载的记录，当前页码会高亮。消息默认显示预览，消息之间用横线分隔。助手回复的名字前有平台图标 🐋 DeepSeek、✴️ Claude Code、🤖 Codex。点预览或右侧箭头直接展开和收起正文及图片，正文里的 Markdown 表格、标题和代码按富文本显示。超出卡片容量的正文可点「展开」载入，特别长的单条消息可用「上一段 / 下一段」读完。

切换会话时，点卡片底部的「返回列表」，再选要打开的会话。电脑端用户消息用飞书敲键盘表情标识，手机发出的消息用 📱 标识。

最新一页会根据当前会话最近三轮消息生成最多三个追问建议，与「刷新」「返回列表」同排。桥接通过本机已登录的 Codex，在后台把当前会话最近三轮的有限文本交给模型生成中文追问。这次生成使用临时会话，结果就绪后自动更新卡片。桥接运行期间刷新同一段对话会复用结果。模型没有给出建议时只显示原有操作。点建议才会把问题发给当前会话。在聊天框发送 `/close` 可解除当前飞书聊天和本机会话的关联。

原生折叠面板里的表格也计入单张卡片的限制，表格较多时可通过「展开」按需载入和分段阅读。飞书拒绝更新卡片时，可在 `data/bridge.log` 查看具体的校验错误。

## 已知限制

- 一个回合内的消息不逐条推送，只在 `end_turn` 时推一条摘要。
- 飞书收到消息必须 3 秒内响应，因此消息处理一律异步，先回执后出结果。
- 长连接是集群模式：同一应用开多个实例时，消息只会被随机一个实例收到。**不要同时跑两份**（已用 PID 锁拦截）。
- 执行权限为 `bypassPermissions`（完全放行）。第一个发消息的人会被记录为唯一所有者，其他人的消息一律忽略。要换人，删除 `data/state.json` 里的 `ownerOpenId`。
- 手机消息「立即插入」正在电脑上运行的会话时，可能与电脑上的操作交错，这是已知取舍。
- 开机自启与进程结束目前只有 Windows 实现。
- Cursor、WorkBuddy 没有可用的续跑命令，不在这张卡片里。MarsCode、Gemini 仍未接入。

## 规划

- M1 看板：会话列表 + 实时流水 ✅
- M2 通知：回合结束推送 ✅
- M3 写回：手机消息送进电脑上的会话 ✅
- M4 多编辑器：Codex、DeepSeek 已能列出并续跑。进程守护（开机自启、崩溃重启）已有 Windows 实现

## 开发和文档维护

新克隆后，运行 `git config core.hooksPath .githooks` 启用文档更新。每次提交代码时，钩子会根据已暂存的改动更新 README 和 [AGENTS.md](AGENTS.md) 的文件清单，并将更新纳入同一次提交。功能和操作说明随代码更新。

<!-- changed-files:start -->
### 本次提交修改的文件

- AGENT-INSTALL.md
- src/core/codex-desktop.mjs
- src/core/codex-desktop.test.mjs
- src/core/codex.mjs
- src/core/codex.test.mjs
- src/core/failure.mjs
- src/core/failure.test.mjs
- src/core/runner.mjs
- src/index.mjs
<!-- changed-files:end -->
