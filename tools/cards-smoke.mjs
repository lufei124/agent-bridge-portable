/**
 * 卡片结构冒烟检查：不联网，只验证生成的 JSON 结构合法。
 *
 *   node tools/cards-smoke.mjs
 */

import {
  PAGE_SIZE,
  platformListCard,
  sessionListCard,
  sessionCard,
  busyChoiceCard,
  ownerBusyCard,
  stagedFileCard,
  helpCard,
  queueCard,
  stopAskCard,
  newSessionCard,
  searchCard,
  searchAskCard,
  statusCard,
  confirmCloseCard,
  errorCard,
} from '../src/cards.mjs';

const KNOWN_TAGS = new Set([
  'markdown',
  'div',
  'hr',
  'column_set',
  'column',
  'form',
  'input',
  'button',
  'plain_text',
  'collapsible_panel',
  'img',
]);

const problems = [];

function walk(node, pathStr) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${pathStr}[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object') return;

  if (node.tag !== undefined) {
    if (!KNOWN_TAGS.has(node.tag)) problems.push(`${pathStr}: 未知 tag "${node.tag}"`);
    if (node.tag === 'button') {
      const hasCallback = (node.behaviors || []).some((b) => b.type === 'callback');
      const isSubmit = node.action_type === 'form_submit';
      if (!hasCallback && !isSubmit) problems.push(`${pathStr}: 按钮既无 callback 也无 form_submit，点了没反应`);
      if (isSubmit && !node.name) problems.push(`${pathStr}: form_submit 按钮缺少 name`);
    }
    if (node.tag === 'input' && !node.name) problems.push(`${pathStr}: input 缺少 name`);
    if (node.tag === 'markdown' && typeof node.content !== 'string') {
      problems.push(`${pathStr}: markdown 缺少 content`);
    }
    if (node.tag === 'plain_text' && typeof node.content !== 'string') {
      problems.push(`${pathStr}: plain_text 缺少 content`);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'tag') continue;
    walk(value, `${pathStr}.${key}`);
  }
}

function check(name, cardJson) {
  const before = problems.length;
  walk(cardJson, name);
  if (cardJson.schema !== '2.0') problems.push(`${name}: schema 不是 2.0`);
  if (!cardJson.header?.title?.content) problems.push(`${name}: 缺少 header.title`);
  console.log(`${problems.length === before ? '✅' : '❌'} ${name}  (${JSON.stringify(cardJson).length} 字节)`);
}

function assert(ok, message) {
  if (!ok) problems.push(message);
}

/** 收集卡片里所有按钮的文字，用来断言分页按钮存在 */
function collectButtonText(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => collectButtonText(child, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (node.tag === 'button' && node.text?.content) out.push(node.text.content);
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'text') collectButtonText(value, out);
  }
  return out;
}

check(
  'platformListCard',
  platformListCard({
    platforms: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        subtitle: 'VS Code 插件 · 命令行',
        ready: true,
        detected: true,
        sessionCount: 25,
        runningCount: 2,
        unreadCount: 3,
        busy: true,
        updatedText: '刚刚',
      },
      {
        id: 'codex',
        name: 'Codex',
        subtitle: 'OpenAI · 命令行 / IDE',
        ready: false,
        detected: true,
        sessionCount: 0,
        runningCount: 0,
        busy: false,
        updatedText: '—',
      },
    ],
  })
);

const listCard = sessionListCard({
  platformName: 'Claude Code',
  platformId: 'claude-code',
  items: Array.from({ length: PAGE_SIZE }, (_, i) => ({
    id: `9f3a2c1b-0000-0000-0000-00000000000${i}`,
    title: `会话 ${i}`,
    project: 'Project',
    updatedText: `${i} 分钟前`,
    messageCount: 10 + i,
    busy: i === 0,
    unread: i < 2, // 前两条模拟"刚跑完、还没看"
    latestText: i === 0 ? '构建已通过，还剩两个警告' : '',
  })),
  page: 0,
  pages: 2,
  total: 12,
});
check('sessionListCard(第 1 页)', listCard);

for (const [platform, label] of [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['deepseek', 'DeepSeek']]) {
  const emptyList = sessionListCard({ unified: true, filter: platform, items: [] });
  assert(collectButtonText(emptyList).includes(`新建 ${label} 会话`), '空列表也应可新建会话');
  assert(JSON.stringify(emptyList).includes(`"a":"newSession","platform":"${platform}"`), '新建按钮应包含平台');
}

// 分页必须是"下一页"，不能再出现把全部塞进一张卡的老行为。
// 数据行都排在分隔线之前，分隔线之后是底部按钮栏，不算行。
const divider = listCard.body.elements.findIndex((e) => e.tag === 'hr');
const rowCount = listCard.body.elements
  .slice(0, divider === -1 ? undefined : divider)
  .filter((e) => e.tag === 'column_set' && collectButtonText(e).includes('查看')).length;
const labels = collectButtonText(listCard);
assert(rowCount <= PAGE_SIZE, `列表行数 ${rowCount} 超过每页上限 ${PAGE_SIZE}`);
assert(labels.includes('下一页'), '缺少「下一页」按钮');
assert(!labels.includes('查看全部'), '不应该再有「查看全部」（会撑长卡片）');
assert(labels.includes('清空红点'), '有未读时应该出现「清空红点」');
assert(JSON.stringify(listCard).includes('🔴'), '未读会话行应该带红点');
assert(JSON.stringify(listCard).includes('最新：构建已通过'), '运行/未读会话应显示最新一句');
assert(!JSON.stringify(listCard).includes('`9f3a2c1b`'), '会话编号不应显示在列表正文');

// 没有未读时不该出现红点和清空按钮
const cleanCard = sessionListCard({
  platformName: 'Claude Code',
  platformId: 'claude-code',
  items: [{ id: 'a', title: 't', project: 'p', updatedText: '刚刚', messageCount: 1, busy: false }],
  page: 0,
  pages: 1,
  total: 1,
});
assert(!JSON.stringify(cleanCard).includes('🔴'), '没有未读时不该出现红点');
assert(!collectButtonText(cleanCard).includes('清空红点'), '没有未读时不该出现「清空红点」');

check(
  'sessionCard',
  sessionCard({
    title: '修复构建脚本',
    project: 'agent-bridge',
    platformName: 'Claude Code',
    statusText: '🟢 运行中',
    updatedText: '刚刚',
    queued: 1,
    running: true,
    messages: ['**你** 帮我看下构建', '**Claude** 好的'],
    sessionId: '9f3a2c1b-0000-0000-0000-000000000001',
    platformId: 'claude-code',
  })
);

check('busyChoiceCard', busyChoiceCard({ title: '修复构建脚本', excerpt: '先跑一下测试', token: 't-123' }));

const chatMessages = Array.from({ length: 20 }, (_, index) => ({
  id: String(index), kind: index % 2 ? 'assistant' : 'user',
  text: '这行在预览中\n第二行\n' + '长正文'.repeat(3000) + '末尾',
}));
const detail = { title: '对话分页', platformName: 'Codex', sessionId: 'session-1',
  hasOlder: true, hasNewer: true, pageText: '第 2 / 3 页', messages: chatMessages };
const compact = sessionCard(detail);
check('sessionCard(10 轮预览)', compact);
assert(collectButtonText(compact).filter((text) => text === '展开').length === 20, '10 轮应有 20 条可展开消息');
assert(compact.body.elements.filter((el) => el.tag === 'hr').length === 21, '每两条消息之间都应有横线');
assert(!JSON.stringify(compact).includes('末尾'));
for (const label of ['更早', '后一页', '回到最新']) assert(collectButtonText(compact).includes(label));
const expanded = sessionCard({ ...detail, expandedMessage: { id: '1', part: 0 } });
check('sessionCard(展开超长正文)', expanded);
assert(collectButtonText(expanded).includes('收起'));
assert(collectButtonText(expanded).includes('下一段'));
assert(Buffer.byteLength(JSON.stringify(expanded)) < 30_000);

const tableMarkdown = '## 实测数据\n\n| 项目 | 数值 |\n| --- | --- |\n| 主库 | **1.47 GB** |';
for (const [platformId, platformName, icon] of [
  ['deepseek', 'DeepSeek', '🐋'],
  ['claude-code', 'Claude Code', '✴️'],
  ['codex', 'Codex', '🤖'],
]) {
  const args = {
    title: '查看实测数据', sessionId: 'session-1', platformId, platformName,
    messages: [{ id: 'reply', kind: 'assistant', text: `${tableMarkdown}\n\n<at id=all></at>` }],
  };
  const preview = sessionCard(args);
  const previewText = preview.body.elements[2].columns[0].elements[0].text;
  assert(previewText.lines === 2 && previewText.content.startsWith(`${icon} ${platformName}`), `${platformName} 回复缺少平台图标或两行预览`);
  assert(collectButtonText(preview).includes('返回列表'), `${platformName} 会话详情应能返回列表`);
  const opened = sessionCard({ ...args, expandedMessage: { id: 'reply', part: 0 } });
  check(`sessionCard(${platformName} 展开表格)`, opened);
  assert(opened.body.elements.some((el) => el.tag === 'markdown' && el.content.startsWith(tableMarkdown) && !el.content.includes('<at ')),
    `${platformName} 展开正文应保留表格格式，历史提及不应再次触发`);
}

const ownerCard = ownerBusyCard({
  title: '修复构建脚本',
  excerpt: '先跑一下测试',
  token: 't-456',
  sessionId: '9f3a2c1b-0000-0000-0000-000000000001',
  busy: false,
  source: 'claude-vscode',
});
check('ownerBusyCard(空闲可接管)', ownerCard);
assert(collectButtonText(ownerCard).includes('接管'), '空闲时应提供「接管」按钮，让手机直接把电脑端进程挤下线');
assert(collectButtonText(ownerCard).includes('重试'), '空闲时也应保留「重试」（关标签页后再发）');

const ownerBusy = ownerBusyCard({
  title: '修复构建脚本',
  excerpt: '先跑一下测试',
  token: 't-789',
  sessionId: '9f3a2c1b-0000-0000-0000-000000000001',
  busy: true,
  source: 'claude-vscode',
});
check('ownerBusyCard(运行中)', ownerBusy);
assert(collectButtonText(ownerBusy).includes('接管'), '正在跑时也应提供「接管」（会打断电脑端这一轮）');
assert(collectButtonText(ownerBusy).includes('重试'), '正在跑时也保留重试，等它跑完再点');
check(
  'stagedFileCard',
  stagedFileCard({
    title: '修复构建脚本',
    files: [
      { name: 'screenshot.png', sizeText: '1.2 MB', type: 'image' },
      { name: 'build.log', sizeText: '3 KB', type: 'file' },
    ],
    caption: '看下这张图和日志',
  })
);
const stagedNoCaption = stagedFileCard({
  title: '修复构建脚本',
  files: [{ name: 'build.log', sizeText: '3 KB', type: 'file' }],
  caption: '',
});
assert(collectButtonText(stagedNoCaption).includes('发送'), '附件确认卡要有「发送」');
assert(collectButtonText(stagedNoCaption).includes('取消'), '附件确认卡要有「取消」撤回');

check('helpCard', helpCard());
check(
  'queueCard',
  queueCard({
    title: '修复构建脚本',
    items: [
      { text: '先跑一下测试', at: Date.now() },
      { text: '然后修掉失败项', at: Date.now() },
    ],
  })
);
check('stopAskCard', stopAskCard({ queueCount: 2 }));
check(
  'newSessionCard',
  newSessionCard({
    projects: [
      { name: 'Project', cwd: 'G:\\Project' },
      { name: 'TapTapStarter', cwd: 'G:\\Project\\TapTapStarter' },
    ],
  })
);
check(
  'searchCard',
  searchCard({
    keyword: '构建',
    results: [{ id: 'x', title: '修复构建脚本', project: 'agent-bridge', updatedText: '3 分钟前' }],
  })
);
check('searchAskCard', searchAskCard());
check(
  'statusCard',
  statusCard({ pid: 123, uptime: '01:20:00', sessions: 32, bindings: 2, queues: 0, errors: 0, startedAt: '2026/11/8 02:00:00' })
);
check('confirmCloseCard', confirmCloseCard());
assert(
  collectButtonText(confirmCloseCard()).includes('取消'),
  '解绑确认卡要能取消'
);
check('errorCard', errorCard({ title: '执行失败', detail: 'exit 1' }));
const retryCard = errorCard({ title: '执行失败', detail: 'exit 1', retryToken: 't-1' });
check('errorCard(可重发)', retryCard);
assert(collectButtonText(retryCard).includes('重发上一条'), '错误卡应提供「重发上一条」');
const presetCard = errorCard({
  title: '消息未送达',
  detail: '此 DeepSeek 会话使用电脑端预设，请在电脑上继续。',
  sessionTitle: '排查构建失败',
  sessionId: 'session-abc',
});
check('errorCard(查看会话)', presetCard);
assert(JSON.stringify(presetCard).includes('排查构建失败'), '错误卡应显示会话标题');
assert(collectButtonText(presetCard).includes('查看会话'), '错误卡应提供会话入口');
assert(!collectButtonText(presetCard).includes('重发上一条'), '电脑端预设错误不应提供重发');

if (problems.length) {
  console.error('\n发现问题：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\n全部通过');
