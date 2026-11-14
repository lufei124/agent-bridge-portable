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
import { replySuggestions } from '../src/core/suggestions.mjs';

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
  'standard_icon',
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
const listNav = listCard.body.elements.at(-1);
assert(collectButtonText(listNav).join(',') === '1,2,下一页,刷新', '页码、翻页和刷新应放在同一排');
assert(listNav.columns.at(-2).width === 'weighted' && collectButtonText(listNav.columns.at(-1))[0] === '刷新',
  '刷新按钮应在分页行的最右边');
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
assert(collectButtonText(cleanCard.body.elements.at(-1)).join(',') === '刷新', '单页会话列表应保留右侧刷新');

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
  id: index.toString(16).padStart(16, '0'), kind: index % 2 ? 'assistant' : 'user',
  text: '这行在预览中\n第二行\n' + '长正文'.repeat(3000) + '末尾',
}));
const detail = { title: '对话分页', platformName: 'Codex', platformId: 'codex',
  sessionId: 'session-00000000-0000-4000-8000-000000000001',
  page: 1, pages: 3, messages: chatMessages,
};
const compact = sessionCard(detail);
check('sessionCard(10 轮预览)', compact);
assert(collectButtonText(compact).filter((text) => text === '展开').length === 20, '10 轮应有 20 条可展开消息');
assert(compact.body.elements.filter((el) => el.tag === 'hr').length === 21, '每两条消息之间都应有横线');
assert(!JSON.stringify(compact).includes('末尾'));
const historyPager = compact.body.elements.find((element) => collectButtonText(element).includes('下一页'));
assert(collectButtonText(historyPager).join(',') === '上一页,1,2,3,下一页', '会话详情应使用和列表相同的页码');
const expanded = sessionCard({ ...detail, expandedMessage: { id: chatMessages[1].id, part: 0 } });
check('sessionCard(展开超长正文)', expanded);
assert(collectButtonText(expanded).includes('收起'));
assert(collectButtonText(expanded).includes('下一段'));
assert(Buffer.byteLength(JSON.stringify({ content: JSON.stringify(expanded) })) < 30_000,
  '包含十轮、头像和底部按钮的展开卡片应符合飞书请求体大小限制');

const crowded = sessionCard({ ...detail, messages: chatMessages.map((message) => ({
  ...message, text: message.text.slice(0, 1000),
})) });
const inlinePanels = crowded.body.elements.filter((el) => el.tag === 'collapsible_panel' && el.header.title.content !== '命令与用法');
assert(inlinePanels.length > 0 && collectButtonText(crowded).includes('展开'), '正文较多时应同时支持原生折叠和按需展开');
assert(Buffer.byteLength(JSON.stringify({ content: JSON.stringify(crowded) })) < 30_000,
  '折叠正文也应计入飞书请求体大小限制');

const tableMarkdown = '## 实测数据\n\n| 项目 | 数值 |\n| --- | --- |\n| 主库 | **1.47 GB** |';
const latestReply = '已修复报错，更新代码和配置，测试通过并完成部署。';
const suggestions = replySuggestions(latestReply);
assert(suggestions.length === 3 && new Set(suggestions.map((item) => item.label)).size === 3,
  '多主题回复应生成最多三个不同的建议');
assert(JSON.stringify(replySuggestions(latestReply)) === JSON.stringify(suggestions), '同一回复的建议应保持稳定');
assert(replySuggestions('已部署到生产环境。').every((item) => /变更|部署/.test(item.label))
  && replySuggestions('测试已经通过。').every((item) => /验证|边界/.test(item.label)),
  '不同主题应生成相关的追问');
assert(replySuggestions('`'.repeat(3) + '\n测试\n部署\n' + '`'.repeat(3)).length === 0, '代码示例内的关键词无需生成追问');
for (const [platformId, platformName, icon] of [
  ['deepseek', 'DeepSeek', '🐋'],
  ['claude-code', 'Claude Code', '✴️'],
  ['codex', 'Codex', '🤖'],
]) {
  const args = {
    title: '查看实测数据', sessionId: 'session-1', platformId, platformName,
    suggestions,
    messages: [{ id: 'reply', kind: 'assistant', text: `${tableMarkdown}\n\n<at id=all></at>` }],
  };
  const preview = sessionCard(args);
  const panel = preview.body.elements[2];
  const previewText = panel.header.title;
  assert(panel.tag === 'collapsible_panel' && !panel.expanded && !collectButtonText(panel).length,
    `${platformName} 消息应由飞书客户端直接展开和收起`);
  assert(previewText.lines === 2 && previewText.content.startsWith(`${icon} ${platformName}`), `${platformName} 回复缺少平台图标或两行预览`);
  const controls = preview.body.elements.at(-1);
  assert(controls.flex_mode === 'none' && collectButtonText(controls).join(',') === ['刷新', '返回列表', ...suggestions.map((item) => item.label)].join(','),
    `${platformName} 底部应保留刷新、返回列表和最多三个追问`);
  for (const [i, suggestion] of suggestions.entries()) {
    const action = controls.columns[i + 2].elements[0].behaviors[0].value;
    assert(action.a === 'quick' && action.s === args.sessionId && action.m === 'reply' && action.i === i && action.label === suggestion.label,
      '追问按钮应绑定生成它的会话和回复');
  }
  assert(!JSON.stringify(preview).includes('"a":"messagePage"'), `${platformName} 单页会话无需分页按钮`);
  const firstPage = sessionCard({ ...args, pages: 2 });
  const firstPager = firstPage.body.elements.find((element) => collectButtonText(element).includes('下一页'));
  assert(collectButtonText(firstPager).join(',') === '1,2,下一页', `${platformName} 首页应显示数字页码和下一页`);
  const pageTwo = firstPager?.columns[1]?.elements[0]?.behaviors[0]?.value;
  assert(pageTwo?.a === 'messagePage' && pageTwo?.s === args.sessionId && pageTwo?.page === 1,
    `${platformName} 数字页码应跳到同一会话的目标页`);
  const lastPage = sessionCard({ ...args, page: 1, pages: 2 });
  const lastPager = lastPage.body.elements.find((element) => collectButtonText(element).includes('上一页'));
  assert(collectButtonText(lastPager).join(',') === '上一页,1,2' && lastPager?.columns[2]?.elements[0]?.type === 'primary',
    `${platformName} 最后一页应高亮当前页，并可翻回上一页`);
  const userMessages = sessionCard({ ...args, messages: [
    { id: 'desktop', kind: 'user', from: 'desktop', text: '电脑端消息', images: ['img_test'] },
    { id: 'phone', kind: 'user', from: 'phone', text: '手机端消息' },
  ] });
  const [desktopIcon, desktopPanel] = userMessages.body.elements[2].columns.map((col) => col.elements[0]);
  assert(desktopIcon.content === ':Typing:' && desktopPanel.header.title.lines === 2 && desktopPanel.header.title.content.startsWith('你'),
    `${platformName} 的电脑端用户消息应显示敲键盘表情和两行预览`);
  assert(desktopPanel.elements.some((el) => el.tag === 'img' && el.img_key === 'img_test'), '折叠正文应包含图片');
  assert(userMessages.body.elements[4].header.title.content.startsWith('📱 你'),
    `${platformName} 的手机端用户消息应显示手机图标`);
  const opened = sessionCard({ ...args, expandedMessage: { id: 'reply', part: 0 } });
  check(`sessionCard(${platformName} 展开表格)`, opened);
  assert(panel.elements.some((el) => el.tag === 'markdown' && el.content.startsWith(tableMarkdown) && !el.content.includes('<at ')),
    `${platformName} 原生折叠面板应包含富文本表格，并转义历史提及`);
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
