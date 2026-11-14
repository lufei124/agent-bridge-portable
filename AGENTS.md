# Agent Bridge 项目指南

- src/index.mjs 处理飞书回调、会话绑定与任务队列，src/cards.mjs 生成卡片。
- src/core 读取本机会话记录并调用 Claude Code、Codex 和 DeepSeek Harness。
- 会话详情默认显示最新一页。分页按用户消息划分轮次，每页最多十轮。修改消息展示时须同时检查三个平台。
- 提交前运行 `node --test` 和 `node tools/cards-smoke.mjs`。
- 行为、命令、安装或配置有变化时，在同一次提交更新 README。工作约定变更时更新本文件。
- 本地凭据、会话数据、日志和运行时文件应留在本机。

## 自动更新

在新克隆中运行 `git config core.hooksPath .githooks`。提交时钩子会更新 README 和本文件末尾的变更清单。功能说明由修改者随代码维护。

<!-- changed-files:start -->
### 本次提交修改的文件

- src/cards.mjs
- src/core/conversation.mjs
- src/core/conversation.test.mjs
- src/index.mjs
- tools/cards-smoke.mjs
<!-- changed-files:end -->
