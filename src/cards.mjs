import { findPlatform, sessionFilterName } from './platforms.mjs';
import { messageTextPages } from './core/conversation.mjs';

/**
 * 飞书卡片 JSON 2.0 构建。
 *
 * 三层结构：
 *   1. Agent 平台列表（Claude Code / Codex / Cursor …）
 *   2. 某个平台下的会话列表（默认最近 10 条，可展开全部）
 *   3. 会话详情（流水 + 输入框）
 *
 * 这里只负责把视图模型转成卡片结构，不含业务逻辑。
 */

/**
 * 每页条数。
 *
 * 飞书卡片没有内建滚动容器（JSON 2.0 只有分栏/表单/交互容器/折叠面板，
 * interactive_container 的 height 超出部分不会滚动），所以列表用分页来
 * 控制高度：一页固定若干行，翻页而不是往下拖。
 */
export const PAGE_SIZE = 8;

const btn = (text, value, type = 'default') => ({
  tag: 'button',
  text: { tag: 'plain_text', content: text },
  type,
  behaviors: [{ type: 'callback', value }],
});

const md = (content) => ({ tag: 'markdown', content });

/** 行首状态点：有未读完成就盖掉运行状态 */
const dot = (item) => (item.unread ? '🔴' : item.busy ? '🟢' : '⚪');

const hr = () => ({ tag: 'hr' });

const card = (header, elements) => ({
  schema: '2.0',
  config: { update_multi: true },
  header: {
    title: { tag: 'plain_text', content: header.title },
    template: header.template || 'blue',
  },
  body: { elements },
});

const row = (content, buttons) => ({
  tag: 'column_set',
  flex_mode: 'none',
  horizontal_spacing: 'default',
  margin: '0px 0px 6px 0px',
  columns: [
    { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [md(content)] },
    ...buttons.map((b) => ({ tag: 'column', width: 'auto', vertical_align: 'center', elements: [b] })),
  ],
});

const footer = (buttons) => ({
  tag: 'column_set',
  flex_mode: 'none',
  margin: '8px 0px 0px 0px',
  columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
});

/**
 * 消息翻页。
 *
 * 飞书卡片没有滚动容器（JSON 2.0 的组件只能纵向流式排列，交互容器也不滚动），
 * 一页内按时间正序，从最新一页开始，可翻到更早的记录。
 */
const pager = (hasOlder, hasNewer, sessionId) => ({
  tag: 'column_set',
  flex_mode: 'none',
  margin: '2px 0px 0px 0px',
  columns: [
    ...(hasOlder
      ? [
          { tag: 'column', width: 'auto', elements: [btn('最早', { a: 'mfirst', s: sessionId })] },
          { tag: 'column', width: 'auto', elements: [btn('更早', { a: 'mprev', s: sessionId })] },
        ]
      : []),
    ...(hasNewer
      ? [
          { tag: 'column', width: 'auto', elements: [btn('后一页', { a: 'mnext', s: sessionId })] },
          { tag: 'column', width: 'auto', elements: [btn('回到最新', { a: 'mlatest', s: sessionId })] },
        ]
      : []),
  ],
});

// ------------------------------------------------------------ 第 1 层：平台

export function platformListCard({ platforms, page = 0, pages = 1, total = 0 }) {
  const elements = [];

  if (!platforms.length) elements.push(md('本机没有检测到任何 agent 工具。'));

  for (const p of platforms) {
    const status = p.ready
      ? `${p.sessionCount} 个会话` +
        (p.runningCount ? ` · ${p.runningCount} 个运行中` : '') +
        (p.sessionCount ? ` · ${escapeMarkdown(p.updatedText)}` : '')
      : `未接入${p.detected ? '（本机已检测到）' : ''}`;

    elements.push(
      row(
        `**${p.unreadCount ? '🔴' : dot(p)} ${escapeMarkdown(p.name)}**` +
          (p.unreadCount ? `　🔴 ${p.unreadCount} 条新完成` : '') +
          `\n${escapeMarkdown(p.subtitle)} · ${status}`,
        p.ready
          ? [btn('进入', { a: 'src', p: p.id }, 'primary')]
          : [btn('未接入', { a: 'soon', p: p.id })]
      )
    );
  }

  const buttons = [];
  if (page > 0) buttons.push(btn('上一页', { a: 'home', page: page - 1 }));
  if (page < pages - 1) buttons.push(btn('下一页', { a: 'home', page: page + 1 }, 'primary'));
  buttons.push(btn('刷新', { a: 'home', page }));

  elements.push(hr());
  if (pages > 1) elements.push(md(`第 **${page + 1} / ${pages}** 页 · 共 ${total} 个平台`));
  elements.push(footer(buttons));

  return card(
    { title: `Agent 平台 · ${total} 个${pages > 1 ? ` · 第 ${page + 1}/${pages} 页` : ''}`, template: 'blue' },
    elements
  );
}

// ------------------------------------------------------------ 第 2 层：会话列表

export function sessionListCard({
  platformName,
  platformId,
  items,
  page = 0,
  pages = 1,
  total = 0,
  unified = false,
  filter = 'all',
}) {
  const elements = [];

  if (unified) {
    const filterBtn = (id, label) =>
      btn(label, { a: 'home', f: id, page: 0 }, filter === id ? 'primary' : 'default');
    elements.push(
      footer([
        filterBtn('all', '全部'),
        filterBtn('claude-code', 'Claude'),
        filterBtn('codex', 'Codex'),
        filterBtn('deepseek', 'DeepSeek'),
      ])
    );
    elements.push(md('点「查看」打开要发送消息的会话。'));
  }

  const creationPlatform = unified ? filter : platformId;
  if (['claude-code', 'codex', 'deepseek'].includes(creationPlatform)) {
    elements.push(footer([
      btn(`新建 ${sessionFilterName(creationPlatform)} 会话`, { a: 'newSession', platform: creationPlatform }, 'primary'),
    ]));
  }

  if (!total) {
    const emptyName = {
      'claude-code': 'Claude',
      codex: 'Codex',
      deepseek: 'DeepSeek',
    }[filter];
    elements.push(md(!unified ? '这个平台下还没有会话。' : emptyName ? `没有 ${emptyName} 会话。` : '本机还没有会话。'));
  }

  for (const item of items) {
    const metadata = [
      item.source, item.project, item.unread ? `完成于 ${item.updatedText}` : item.updatedText,
      `${item.messageCount} 条`, item.readOnly ? '仅查看' : '', item.runningText ? `🟢 已跑 ${item.runningText}` : '',
    ].filter(Boolean).map(escapeMarkdown).join(' · ');
    elements.push(
      row(
        `**${dot(item)} ${escapeMarkdown(item.title)}**${item.unread ? '　**新完成**' : ''}\n` +
          metadata +
          (item.latestText ? `\n最新：${plainText(item.latestText)}` : ''),
        [btn('查看', { a: 'open', s: item.id }, 'primary')]
      )
    );
  }

  elements.push(hr());
  if (pages > 1) elements.push(md(`第 **${page + 1} / ${pages}** 页 · 共 ${total} 个会话`));

  // 翻页单独一行：一排放太多按钮，飞书会把它们挤成"..."甚至空白
  const pageAction = unified ? 'home' : 'src';
  if (pages > 1) {
    const nav = [];
    const pageValue = (index) =>
      unified ? { a: pageAction, page: index, f: filter } : { a: pageAction, p: platformId, page: index };
    if (page > 0) nav.push(btn('上一页', pageValue(page - 1)));
    const first = Math.max(0, Math.min(page - 1, pages - 3));
    for (let i = first; i < Math.min(pages, first + 3); i++) {
      nav.push(btn(String(i + 1), pageValue(i), i === page ? 'primary' : 'default'));
    }
    if (page < pages - 1) nav.push(btn('下一页', pageValue(page + 1), 'primary'));
    elements.push(footer(nav));
  }

  const actions = [btn('刷新', unified ? { a: 'home', page, f: filter } : { a: 'src', p: platformId, page })];
  if (items.some((i) => i.unread)) {
    actions.push(
      btn('清空红点', unified ? { a: 'readall', p: 'all', page, f: filter } : { a: 'readall', p: platformId, page })
    );
  }
  if (!unified) actions.push(btn('返回平台', { a: 'home' }));
  elements.push(footer(actions));

  // header.title 是 plain_text，不能做 markdown 转义，否则会显示成反斜杠
  return card(
    {
      title: unified
        ? `${sessionFilterName(filter)} · 第 ${page + 1}/${pages} 页`
        : `${platformName} · 第 ${page + 1}/${pages} 页`,
      template: 'blue',
    },
    elements
  );
}

// ------------------------------------------------------------ 第 3 层：会话详情

function messageElements(message, assistantName, sessionId, expandedMessage) {
  if (typeof message === 'string') return [md(message)];
  const sender = message.kind === 'assistant' ? assistantName : message.from === 'phone' ? '📱 你' : '🖥 你';
  const label = [sender, message.time].filter(Boolean).join(' · ');
  const expanded = expandedMessage?.id === message.id;
  const action = { a: 'messageText', s: sessionId, m: message.id };
  const preview = plainText(message.text.slice(0, 140));
  const text = (content, lines) => ({
    tag: 'div',
    text: { tag: 'plain_text', content, ...(lines ? { lines } : {}) },
  });
  const header = {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [
        text(expanded ? label : `${label}  ${preview || '📎 附件'}`, expanded ? undefined : 2),
      ] },
      { tag: 'column', width: 'auto', elements: [btn(expanded ? '收起' : '展开', { ...action, part: expanded ? -1 : 0 })] },
    ],
  };
  if (!expanded) return [header];

  // Preserve Markdown formatting without letting historical text notify people again.
  const parts = messageTextPages(message.text.replace(/<(?=\/?at(?:\s|\/?>))/gi, '&lt;'));
  const part = Math.min(expandedMessage.part, parts.length - 1);
  const images = (message.images || []).slice(0, 3).map((key) => ({ tag: 'img', img_key: key, preview: true }));
  const pageButtons = [];
  if (part > 0) pageButtons.push(btn('上一段', { ...action, part: part - 1 }));
  if (part < parts.length - 1) pageButtons.push(btn('下一段', { ...action, part: part + 1 }));
  return [
    header,
    ...(part === 0 ? images : []),
    ...(parts[part] ? [md(parts[part])] : []),
    ...(pageButtons.length ? [text(`第 ${part + 1} / ${parts.length} 段`), footer(pageButtons)] : []),
  ];
}

export function sessionCard({
  title,
  project,
  platformName,
  holder = '⚪ 空闲',
  statusText,
  updatedText,
  queued,
  running,
  runningFor = '',
  messages,
  expandedMessage = null,
  progress = null,
  stopped = '',
  hint = '',
  hasOlder = false,
  hasNewer = false,
  pageText = '',
  thinkingOff = false,
  tone = '',
  quickReplies = [],
  sessionId,
  platformId,
  readOnly = false,
}) {
  const platform = findPlatform(platformId);
  const assistantName = [platform?.icon, platformName || platform?.name || 'Claude'].filter(Boolean).join(' ');

  // 头部压成一行：持有者 · 已跑时长 · 最后活跃 · 排队
  const metaLine = [
    escapeMarkdown(platformName),
    holder,
    runningFor ? `已跑 ${runningFor}` : statusText,
    escapeMarkdown(updatedText),
    queued ? `排队 ${queued}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // 进度提到卡片顶部：置顶卡打开时停在顶部，一眼就能看到在干什么
  const progressLine = (() => {
    if (!progress) return '';
    const bits = ['⏳ 工作中'];
    if (progress.elapsed) bits.push(progress.elapsed);
    bits.push(`活动 ${progress.idle || '00:00'}`);
    if (progress.steps) bits.push(`第 ${progress.steps} 步 ${'●'.repeat(Math.min(progress.steps, 5))}`);
    const head = `**${escapeMarkdown(assistantName)}** ${bits.join(' · ')}`;
    if (progress.preview) return `${head}\n\n${plainText(progress.preview)}`;
    if (progress.thinking) return `${head}\n\n🧠 ${plainText(progress.thinking)}`;
    return head;
  })();

  const elements = [
    md(metaLine),
    hr(),
    ...(progressLine ? [md(progressLine), hr()] : []),
    ...(stopped
      ? [
          md(`⚠️ **已停止** · 部分输出：\n\n${plainText(stopped)}`),
          {
            tag: 'column_set',
            flex_mode: 'none',
            margin: '4px 0px 0px 0px',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [btn('继续上一轮', { a: 'resumeLast' }, 'primary')],
              },
            ],
          },
          hr(),
        ]
      : []),
    ...(messages.length
      ? messages.flatMap((message, index) => [
          ...(index ? [hr()] : []),
          ...messageElements(message, assistantName, sessionId, expandedMessage),
        ])
      : [md('_还没有对话记录_')]),
    ...(hasOlder || hasNewer ? [md(pageText || ''), pager(hasOlder, hasNewer, sessionId)] : []),
    ...(running
      ? [
          {
            tag: 'column_set',
            flex_mode: 'none',
            margin: '2px 0px 0px 0px',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [btn(thinkingOff ? '显示思考' : '隐藏思考', { a: 'think' })],
              },
              ...(queued
                ? [{ tag: 'column', width: 'auto', elements: [btn(`队列 ${queued}`, { a: 'queueList' })] }]
                : []),
              { tag: 'column', width: 'auto', elements: [btn('停止', { a: 'stop' }, 'danger')] },
            ],
          },
        ]
      : queued
        ? [
            {
              tag: 'column_set',
              flex_mode: 'none',
              margin: '2px 0px 0px 0px',
              columns: [
                { tag: 'column', width: 'auto', elements: [btn(`查看队列 ${queued}`, { a: 'queueList' })] },
              ],
            },
          ]
        : []),
    ...(hint ? [hr(), md(`💡 ${escapeMarkdown(hint)}`)] : []),
    ...(quickReplies.length
      ? [
          {
            tag: 'column_set',
            flex_mode: 'none',
            margin: '6px 0px 0px 0px',
            columns: quickReplies.map((q) => ({
              tag: 'column',
              width: 'auto',
              elements: [btn(q, { a: 'quick', q })],
            })),
          },
        ]
      : []),
    hr(),
    // 卡片里不再放输入框：卡片每秒重建一次，输入框会被清空。
    // 发送统一走聊天框——它固定在底部，卡片怎么刷新都不受影响。
    md(
      readOnly
        ? escapeMarkdown(typeof readOnly === 'string' ? readOnly : '👀 这条会话目前只能查看，还不能从飞书接着发')
        : `💬 在聊天框输入即可发给当前 ${escapeMarkdown(platformName || 'Agent')} 会话 · 📎 图片/文件用「+」`
    ),
    ...(readOnly
      ? []
      : [
          {
            tag: 'collapsible_panel',
            expanded: false,
            header: {
              title: { tag: 'plain_text', content: '命令与用法' },
              padding: '2px',
            },
            elements: [
              md(
                '`/files` 看本会话附件 · `/use 3` 复用第 3 个 · `/drop` 丢弃待发附件\n' +
                  '`/queue 内容` 排队 · `/now 内容` 排到队首 · `/notify on|off` 完成摘要\n' +
                  '图片/文件：聊天框「+」，先确认再读，可撤回。'
              ),
            ],
          },
        ]),
    footer([
      btn('刷新', { a: 'open', s: sessionId }),
      btn('返回列表', { a: 'home' }),
      btn('解绑', { a: 'closeAsk' }),
    ]),
  ];

  const titleText = title.length > 20 ? `${title.slice(0, 20)}…` : title;
  return card(
    { title: `${running ? '🟢' : '⚪'} ${titleText}`, template: tone || (running ? 'green' : 'blue') },
    elements
  );
}

// ------------------------------------------------------------ 其他

export function busyChoiceCard({ title, excerpt, token }) {
  return card({ title: '会话运行中', template: 'orange' }, [
    md(`「${escapeMarkdown(title)}」正在电脑上运行。\n\n> ${plainText(excerpt)}`),
    footer([btn('立即插入', { a: 'now', t: token }, 'primary'), btn('排队等待', { a: 'queue', t: token })]),
  ]);
}

/**
 * 会话被电脑端持有时的拦截卡。
 *
 * 之前没有这张卡：手机发的消息会交给电脑端排队，然后被静默丢弃，
 * 手机上什么反馈都没有。现在要么明确拒绝，要么让你主动接管。
 */
export function ownerBusyCard({ title, excerpt, token, sessionId, busy, source }) {
  const elements = [
    md(
      `**「${escapeMarkdown(title)}」** 现在由${escapeMarkdown(source || '电脑端')}持有。\n\n` +
        `> ${plainText(excerpt)}`
    ),
  ];

  if (busy) {
    elements.push(
      md('它正在跑一轮。点「接管」会**打断电脑端这一轮**，然后手机直接发；不想打断就等它跑完再点「重试」。')
    );
  } else {
    elements.push(
      md(
        '这个会话正在电脑上开着。点「接管」会让**电脑端这个进程退出**，然后手机直接发；\n' +
          '也可以先在电脑上关掉标签页，再点「重试」。手机会把你这条留着，不用重打。'
      )
    );
  }

  elements.push(
    footer([
      btn('接管', { a: 'takeover', t: token }, 'primary'),
      btn('重试', { a: 'retry', t: token }),
      btn('取消', { a: 'open', s: sessionId }, 'danger'),
    ])
  );

  return card({ title: busy ? '🖥 电脑端正在运行' : '🖥 电脑端占着这个会话', template: 'orange' }, elements);
}

/**
 * 附件确认卡：手机发来图片/文件后，先确认目标会话再决定读不读。
 * 这张卡取代会话详情卡原地显示，所以用 consoleMessages 的 message_id 刷新。
 */
export function stagedFileCard({ title, files = [], caption }) {
  const list = files
    .map((f, i) => `${i + 1}. 📎 ${escapeMarkdown(f.name)}（${escapeMarkdown(f.sizeText)}）`)
    .join('\n');
  const lines = [
    `**📎 ${files.length} 个附件**`,
    list,
    `\n将发给 **「${escapeMarkdown(title)}」**`,
  ];
  if (caption) lines.push(`\n**说明**\n${plainText(caption)}`);
  lines.push('\n点「发送」才开始读；点「取消」撤回，不会白跑一轮。');

  // 图片直接给缩略图，别让人对着文件名猜是哪张
  const thumbs = files
    .filter((f) => f.imageKey)
    .slice(0, 3)
    .map((f) => ({ tag: 'img', img_key: f.imageKey, preview: true }));

  return card({ title: `确认发送附件（${files.length}）`, template: 'green' }, [
    ...thumbs,
    md(lines.join('\n')),
    footer([
      btn('发送', { a: 'sendfile' }, 'primary'),
      btn('取消', { a: 'cancelfile' }, 'danger'),
    ]),
  ]);
}

/** 帮助卡 */
export function helpCard() {
  return card({ title: '❓ 用法', template: 'blue' }, [
    md(
      '**发送**：聊天框直接输入，发给当前打开的会话；它正在跑时自动排队。\n' +
        '**图片/文件**：聊天框「+」，可以连发多张再配一句说明；确认卡上点「发送」才真正去读。\n\n' +
        '**命令**\n' +
        '- `/files` 列出本会话的附件\n' +
        '- `/use 3` 把第 3 个附件重新发给当前会话\n' +
        '- `/drop` 丢弃还没发送的附件\n' +
        '- `/queue 内容` 排队 · `/now 内容` 排到队首\n' +
        '- `/notify on|off` 完成时是否另发一条摘要\n' +
        '- `/clean on|off` 群聊里是否撤回你发过的消息（默认关，撤回会留提示）\n' +
        '- `/find 关键字` 搜索会话（标题/项目/消息）\n' +
        '- `/new` 新建 Claude 会话 · `/new codex` 新建 Codex 会话 · `/new deepseek` 新建 DeepSeek 会话\n' +
        '- `/open <id>` 打开会话 · `/close` 解绑 · `/status` 刷新卡片'
    ),
  ]);
}

/** 排队列表：能看、能单独取消、能清空 */
export function queueCard({ title, items = [] }) {
  const elements = [md(`**「${escapeMarkdown(title)}」排队中**`)];
  if (!items.length) {
    elements.push(md('_队列已经空了_'));
  } else {
    items.forEach((it, i) => {
      elements.push(
        row(`${i + 1}. ${plainText(it.text).slice(0, 80)}`, [
          ...(i > 0 ? [btn('置顶', { a: 'qtop', i })] : []),
          btn('取消', { a: 'qcancel', i }, 'danger'),
        ])
      );
    });
  }
  elements.push(
    footer([
      btn('清空队列', { a: 'qclear' }, 'danger'),
      btn('返回会话', { a: 'open' }),
    ])
  );
  return card({ title: `排队 ${items.length} 条`, template: 'orange' }, elements);
}

/** 停止前：队列里还有东西时，让用户选是否一起清掉 */
export function stopAskCard({ queueCount }) {
  return card({ title: '停止当前这一轮？', template: 'orange' }, [
    md(`队列里还有 **${queueCount}** 条，停止后会自动继续跑。`),
    footer([
      btn('停止并清空队列', { a: 'stopAll' }, 'danger'),
      btn('只停止', { a: 'stopOnly' }, 'primary'),
    ]),
  ]);
}

/** 新建会话：先选项目目录（最近用过的 + 手填路径） */
export function newSessionCard({ projects = [], platform = 'claude-code' }) {
  const platformName = sessionFilterName(platform);
  const elements = [md('选一个项目目录，然后在聊天框发送第一条消息。')];
  for (const p of projects) {
    elements.push(
      row(`**${escapeMarkdown(p.name)}**\n\`${escapeMarkdown(p.cwd)}\``, [btn('选它', { a: 'newproj', p: p.cwd, platform }, 'primary')])
    );
  }
  if (!projects.length) elements.push(md('_还没有历史项目，可以在下面手填路径_'));
  elements.push(md('**其它目录**'));
  elements.push({
    tag: 'form',
    name: 'Form_new',
    elements: [
      {
        tag: 'input',
        name: 'path',
        input_type: 'multiline_text',
        rows: 1,
        width: 'fill',
        placeholder: { tag: 'plain_text', content: '例如 G:\\Project\\某项目' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '用这个目录' },
        type: 'primary',
        action_type: 'form_submit',
        name: 'btn_newpath',
        value: { a: 'newpath', platform },
      },
    ],
  });
  elements.push(footer([btn('返回列表', { a: 'home', f: platform })]));
  return card({ title: `新建 ${platformName} 会话`, template: 'blue' }, elements);
}

/** 搜索会话 */
export function searchCard({ keyword, results = [] }) {
  const elements = [md(`搜索 **${escapeMarkdown(keyword)}**：${results.length} 个结果`)];
  if (!results.length) elements.push(md('_没有匹配的会话_'));
  for (const r of results) {
    elements.push(
      row(
        `**${escapeMarkdown(r.title)}**\n${escapeMarkdown(r.project)} · ${escapeMarkdown(r.updatedText)}`,
        [btn('打开', { a: 'open', s: r.id }, 'primary')]
      )
    );
  }
  elements.push(footer([btn('继续搜索', { a: 'searchAsk' })]));
  return card({ title: '搜索会话', template: 'blue' }, elements);
}

/** 搜索输入框（单独的静态卡，不会被自动刷新） */
export function searchAskCard() {
  return card({ title: '搜索会话', template: 'blue' }, [
    {
      tag: 'form',
      name: 'Form_search',
      elements: [
        {
          tag: 'input',
          name: 'q',
          input_type: 'multiline_text',
          rows: 1,
          width: 'fill',
          placeholder: { tag: 'plain_text', content: '标题、项目名或消息内容' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '搜索' },
          type: 'primary',
          action_type: 'form_submit',
          name: 'btn_search',
          value: { a: 'search' },
        },
      ],
    },
  ]);
}

/** 运行状态卡 */
export function statusCard({ pid, uptime, sessions, bindings, queues, errors, startedAt }) {
  return card({ title: '📊 桥的状态', template: 'blue' }, [
    md(
      `**进程**　PID ${pid} · 已运行 ${uptime}\n` +
        `**启动于**　${startedAt}\n` +
        `**监听会话**　${sessions} 个\n` +
        `**已绑定聊天**　${bindings} 个\n` +
        `**排队中**　${queues} 条\n` +
        `**错误计数**　${errors}`
    ),
  ]);
}

/** 解绑前的二次确认 */
export function confirmCloseCard() {
  return card({ title: '解绑这个会话？', template: 'orange' }, [
    md('解绑后，聊天框里发的内容不会再送到这个会话；需要从列表重新打开。'),
    footer([btn('确认解绑', { a: 'close' }, 'danger'), btn('取消', { a: 'closeCancel' })]),
  ]);
}

export function errorCard(options) {
  return sessionNoticeCard({ ...options, title: `❌ ${options.title}`, template: 'red' });
}

export function sessionNoticeCard({ title, detail, retryToken, sessionTitle, sessionId, template = 'green' }) {
  const elements = [md(plainText(detail).slice(0, 2000))];
  if (sessionTitle) elements.unshift(md(`**${escapeMarkdown(sessionTitle)}**`));
  const actions = [];
  if (retryToken) {
    actions.push(btn('重发上一条', { a: 'retrySend', t: retryToken }, 'primary'));
  }
  if (sessionId) actions.push(btn('查看会话', { a: 'open', s: sessionId }));
  if (actions.length) elements.push(footer(actions));
  return card({ title, template }, elements);
}

export function escapeMarkdown(text) {
  return String(text ?? '').replace(/([*_`~[\]])/g, '\\$1');
}

/**
 * 把 Markdown 剥成手机上好读的纯文本。
 *
 * 以前是给消息内容做转义，结果 `**`、`` ` ``、``` 全都原样显示在卡片上，
 * 手机上看到的就是一堆符号噪声。这里反过来：去掉标记、留下字。
 *
 * keepLines = true 时保留换行——长回复按段落显示，读起来才不费劲。
 */
export function stripMarkdown(text, keepLines = false) {
  const stripped = String(text ?? '')
    // 围栏代码块：去掉 ``` 和语言名，保留代码本身。
    // 注意别顺手吃掉后面的换行，否则列表项会跟上一行粘在一起
    .replace(/```[a-zA-Z0-9_+-]*/g, ' ')
    // 行内代码
    .replace(/`([^`]*)`/g, '$1')
    // [文字](链接) → 文字
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 加粗 / 斜体 / 删除线
    .replace(/(\*\*\*|\*\*|\*|___|__|~~)/g, '')
    // 标题、引用、列表符号
    .replace(/^\s{0,3}(#{1,6}|>|[-*+])\s+/gm, '');

  if (keepLines) {
    return stripped.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  return stripped.replace(/\s+/g, ' ').trim();
}

export function plainText(text) {
  return stripMarkdown(text, false);
}
