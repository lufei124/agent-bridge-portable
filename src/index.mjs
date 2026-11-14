/**
 * 守护进程入口：监听 Claude Code 会话 + 飞书双向通道（卡片界面）。
 *
 * 用法：npm start   （会读取 .env）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { TranscriptStore } from './core/transcript.mjs';
import { CodexStore } from './core/codex.mjs';
import { DshStore } from './core/dsh.mjs';
import { conversationBrief, usefulProject } from './core/brief.mjs';
import { conversationPage, conversationTurns, TURNS_PER_PAGE } from './core/conversation.mjs';
import { SessionSuggestions, suggestionContext } from './core/suggestions.mjs';
import { explainFailure } from './core/failure.mjs';
import { FeishuChannel } from './channels/feishu.mjs';
import { generateFollowUps, runFresh, runSession } from './core/runner.mjs';
import { findOwners, invalidateCache } from './core/patrol.mjs';
import {
  PAGE_SIZE,
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
  sessionNoticeCard,
  escapeMarkdown,
} from './cards.mjs';
import { filterFromMenuText, findPlatform, normalizeListFilter, sessionFilterName } from './platforms.mjs';

const STATE_DIR = path.resolve('data');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
// 手机发来的图片/文件落在这里；提示词里给 Claude 绝对路径，让它自己 Read
const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
const PENDING_TTL_MS = 10 * 60 * 1000;

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error(
    '缺少飞书凭证。请在 agent-bridge/.env 中填写：\n' +
      '  FEISHU_APP_ID=cli_xxx\n' +
      '  FEISHU_APP_SECRET=xxx\n' +
      '（复制 .env.example 为 .env）'
  );
  process.exit(1);
}

const state = loadState();
acquireLock();

const store = new TranscriptStore({
  dir: process.env.CLAUDE_PROJECTS_DIR || undefined,
  pollMs: Number(process.env.POLL_MS) || 800,
  historyLimit: Number(process.env.HISTORY_LIMIT) || 60,
});

const codexStore = new CodexStore({
  dir: process.env.CODEX_SESSIONS_DIR || undefined,
  pollMs: Number(process.env.POLL_MS) || 2000,
  historyLimit: Number(process.env.HISTORY_LIMIT) || 60,
});

const dshStore = new DshStore({
  dir: process.env.DSH_SESSIONS_DIR || undefined,
  pollMs: Number(process.env.POLL_MS) || 2000,
  historyLimit: Number(process.env.HISTORY_LIMIT) || 60,
});

const inflight = new Set();
const drafts = new Map(); // 卡片里待确认的文本：token -> {text, sessionId, chatId, at}
const runStartedAt = new Map(); // sessionId -> 本轮开始时间，用于显示已跑多久
const heartbeats = new Map(); // sessionId -> 定时器，运行期间定期刷新详情卡
const lastUrgentAt = new Map(); // chatId -> 上次加急时间，避免连续弹窗
const streaming = new Map(); // sessionId -> 本轮正在生成、还没落进 transcript 的文字
const thinkingBuf = new Map(); // sessionId -> 模型正在思考的内容（没有正文时顶上）
const runSteps = new Map(); // sessionId -> 本轮已经执行的工具步数（只报数，不报内容）
const runningChild = new Map(); // sessionId -> 当前运行中子进程 PID
const canceledRuns = new Set(); // sessionId -> 用户主动点了「停止」
const phoneTurns = new Map(); // sessionId -> 手机发起这一轮时的原始消息 id
const cleanupWarned = new Set(); // chatId -> 群消息撤回失败只提示一次
const pinWarned = new Set(); // chatId -> 置顶失败只提示一次
const lastPartial = new Map(); // sessionId -> 被停止时已生成的部分内容
const sessionSuggestions = new SessionSuggestions(generateFollowUps, (error) => {
  console.warn('[suggestions]', error.message);
});
const BOOT_AT = Date.now();
let errorCount = 0; // 本次运行期间的失败次数（状态卡用）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const channel = new FeishuChannel({
  appId,
  appSecret,
  onMessage: handleIncoming,
  onCardAction: handleCardAction,
});

store.on('turn:end', (session) => {
  notifyTurnEnd(session).catch((err) => console.error('[notify] 推送失败:', err?.message || err));
  maybePhoneSummary(session).catch((err) => console.error('[summary] 失败:', err?.message || err));
  drainQueue(session).catch((err) => console.error('[queue] 执行失败:', err?.message || err));
});

store.on('error', (err) => console.error('[store]', err?.message || err));

// ---------------------------------------------------------------- 卡片回调

async function handleCardAction(payload) {
  const action = payload.action || {};
  const context = payload.context || {};
  const operator = payload.operator || {};
  const chatId = context.open_chat_id || state.lastChatId;
  const value = action.value || {};
  const form = action.form_value || {};

  if (!(await acceptOwner(operator.open_id))) {
    return { toast: { type: 'error', content: '无权操作' } };
  }

  // 卡片是被点的那一条原地替换，记住它的 message_id，之后才能静默刷新
  if (context.open_message_id) {
    state.consoleMessages[chatId] = context.open_message_id;
    // 这张一次性卡片刚被点过、马上会被原地替换成别的卡，
    // 从登记表里摘掉，避免以后被当成"过期卡片"删掉
    forgetTransient(chatId, context.open_message_id);
  }

  console.log(`[card] ${value.a || action.tag || '?'} ${value.s ? String(value.s).slice(0, 8) : ''}`);

  switch (value.a) {
    case 'home': {
      clearTransient(chatId, 'error');
      delete state.newCwd[chatId];
      delete state.pending[chatId];
      const filter = rememberFilter(chatId, value.f);
      const page = Number(value.page) || 0;
      return view(chatId, { kind: 'home', page, f: filter }, homeCard(page, filter));
    }

    case 'src':
      return view(chatId, { kind: 'list', p: value.p, page: Number(value.page) || 0 },
        sessionListCardFor(value.p, value.page));

    case 'readall': {
      if (value.p === 'all') {
        for (const session of everySession()) delete state.unread[session.id];
      } else {
        clearUnread(value.p);
      }
      await saveState();
      return { toast: { type: 'success', content: '红点已清空' },
        card: raw(value.p === 'all' ? homeCard(value.page, rememberFilter(chatId, value.f)) : sessionListCardFor(value.p, value.page)) };
    }

    case 'soon': {
      const platform = findPlatform(value.p);
      return { toast: { type: 'info', content: `${platform?.name || value.p} 还没接入，先接 Claude Code` } };
    }

    case 'open':
      return openCard(chatId, value.s);

    case 'send':
      return submitFromCard(chatId, value.s, form.prompt);

    case 'now':
      return resolveDraft(chatId, value.t, true);

    case 'retry':
      return retryFromBusy(chatId, value.t);

    case 'takeover':
      return takeoverFromBusy(chatId, value.t);

    case 'messagePage':
      if (!Number.isSafeInteger(value.page) || value.page < 0) {
        return { toast: { type: 'info', content: '页码无效，请刷新后再试' } };
      }
      return pageMessages(chatId, value.page, value.s);

    case 'mprev':
      return pageMessages(chatId, msgPageOf(chatId) + 1, value.s);

    case 'mnext':
      return pageMessages(chatId, msgPageOf(chatId) - 1, value.s);

    case 'mlatest':
      return pageMessages(chatId, 0, value.s);

    case 'messageText':
      return toggleMessageText(chatId, value);

    case 'think':
      return toggleThinking(chatId);

    case 'stop':
      return stopRun(chatId);

    case 'queueList':
      return showQueue(chatId);

    case 'qcancel':
      return cancelQueueItem(chatId, Number(value.i));

    case 'qclear':
      return clearQueue(chatId);

    case 'quick':
      return quickSend(chatId, value);

    case 'qtop':
      return topQueueItem(chatId, Number(value.i));

    case 'stopAll':
      return stopRun(chatId, { clearQueue: true });

    case 'stopOnly':
      return stopRun(chatId, { clearQueue: false, confirmed: true });

    case 'newproj':
      return chooseNewProject(chatId, value.p, value.platform);

    case 'newpath':
      return chooseNewProject(chatId, String(form.path || '').trim(), value.platform);

    case 'newDeepseek':
    case 'newSession': {
      const requested = value.a === 'newDeepseek' ? 'deepseek' : value.platform;
      const platform = normalizeListFilter(requested);
      if (platform === 'all') return { toast: { type: 'error', content: '请选择会话平台' } };
      delete state.newCwd[chatId];
      delete state.pending[chatId];
      return view(chatId, { kind: 'new', p: platform }, newSessionCardFor(platform));
    }

    case 'searchAsk':
      return sendTransient(chatId, 'search', searchAskCard());

    case 'search':
      return showSearch(chatId, String(form.q || '').trim());

    case 'mfirst':
      return pageMessages(chatId, Infinity, value.s);

    case 'resumeLast': {
      const view = state.views[chatId];
      const session = findSession(view?.s) || boundSession(chatId);
      if (!session) return { toast: { type: 'error', content: '会话不存在' } };
      const blocked = readOnlyReason(session);
      if (blocked) return { toast: { type: 'info', content: blocked }, card: raw(renderSession(session, chatId)) };
      lastPartial.delete(session.id);
      startRun(chatId, session.id, '继续刚才未完成的工作', { silent: true }).catch((err) =>
        console.error('[run]', err?.message || err)
      );
      return { toast: { type: 'success', content: '已继续' }, card: raw(renderSession(session, chatId)) };
    }

    case 'closeAsk':
      return { card: raw(confirmCloseCard()) };

    case 'closeCancel':
      return openCard(chatId);

    case 'retrySend':
      return retrySend(chatId, value.t);

    case 'queue':
      return resolveDraft(chatId, value.t, false);

    case 'sendfile':
      return confirmFile(chatId);

    case 'cancelfile':
      return cancelFile(chatId);

    case 'close': {
      delete state.bindings[chatId];
      delete state.newCwd[chatId];
      state.views[chatId] = { kind: 'home', f: filterOf(chatId) };
      await saveState();
      return { toast: { type: 'success', content: '已解绑' }, card: raw(homeCard(0, filterOf(chatId))) };
    }

    default:
      return { toast: { type: 'info', content: '未知操作' } };
  }
}

async function openCard(chatId, sessionId) {
  const session = findSession(sessionId || state.bindings[chatId]);
  if (!session) return { toast: { type: 'error', content: '会话不存在，返回列表重新选择' } };
  clearTransient(chatId, 'error');

  delete state.newCwd[chatId];
  delete state.pending[chatId];
  state.bindings[chatId] = session.id;
  state.views[chatId] = { kind: 'session', s: session.id };
  delete state.unread[session.id]; // 打开即视为已读
  msgPages.set(chatId, 0); // 打开就看最新一页
  expandedMessages.delete(chatId);
  await saveState();
  // 打开会话就持续盯着：即使现在是空闲的，电脑端下一轮开始时也能及时刷出来
  startHeartbeat(chatId, session.id);
  return { card: raw(renderSession(session, chatId)) };
}

/** 隐藏 / 显示模型思考内容（偏好按聊天记住） */
async function toggleThinking(chatId) {
  if (!state.thinkingOff) state.thinkingOff = {};
  state.thinkingOff[chatId] = !state.thinkingOff[chatId];
  await saveState();

  const view = state.views[chatId];
  const session = findSession(view?.s) || boundSession(chatId);
  if (!session) {
    return { toast: { type: 'success', content: state.thinkingOff[chatId] ? '已隐藏思考' : '已显示思考' } };
  }
  return { card: raw(renderSession(session, chatId)) };
}

function pageMessages(chatId, page, sessionId) {
  const view = state.views[chatId];
  const session = findSession(view?.s) || boundSession(chatId);
  if (!session || (sessionId && sessionId !== session.id)) return { toast: { type: 'error', content: '请重新打开会话' } };

  const next = Math.max(0, Math.min(maxMsgPage(session), page));
  msgPages.set(chatId, next);
  expandedMessages.delete(chatId);
  return { card: raw(renderSession(session, chatId)) };
}

function toggleMessageText(chatId, { s: sessionId, m: id, part }) {
  const session = boundSession(chatId);
  if (!session || session.id !== sessionId || !Number.isSafeInteger(part) || part < -1) {
    return { toast: { type: 'info', content: '请重新打开会话' } };
  }
  const turns = conversationTurns(session.messages);
  const page = Math.min(msgPageOf(chatId), maxMsgPage(session, turns));
  const message = conversationPage(turns, page).find((item) => messageId(item) === id);
  if (!message) return { card: raw(renderSession(session, chatId)) };
  if (part === -1) expandedMessages.delete(chatId);
  else expandedMessages.set(chatId, { sessionId, id, part });
  return { card: raw(renderSession(session, chatId)) };
}

/**
 * 附件确认卡上的「发送」。
 *
 * 到这一步才真正把文件交给会话：之前只下载、没读，点取消就撤掉，
 * 所以不存在"误发后追悔"的问题——它还没开始跑。
 */
async function confirmFile(chatId) {
  const st = state.staged[chatId];
  if (!st) return { toast: { type: 'error', content: '这条已经处理过了' } };
  delete state.staged[chatId];
  await saveState();

  const prompt = mediaPrompt(st.uploads, st.text);

  // 新建会话模式：拿这批附件去起一个新会话
  if (st.cwd) {
    startFreshRun(chatId, prompt, { cwd: st.cwd, platform: st.platform }, null).catch((err) =>
      console.error('[run]', err?.message || err)
    );
    return { toast: { type: 'success', content: '已发送，正在新建会话' } };
  }

  const session = findSession(st.sessionId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };
  const blocked = readOnlyReason(session);
  if (blocked) return { toast: { type: 'info', content: blocked }, card: raw(renderSession(session, chatId)) };

  for (const upload of st.uploads) recordUpload(upload, chatId, session.id);
  startRun(chatId, session.id, prompt, { silent: true }).catch((err) =>
    console.error('[run]', err?.message || err)
  );
  return { toast: { type: 'success', content: '已发送' }, card: raw(renderSession(session, chatId)) };
}

/** 附件确认卡上的「取消」：撤回，删掉已下载的临时文件，什么都不发 */
async function cancelFile(chatId) {
  const st = state.staged[chatId];
  if (!st) return { toast: { type: 'error', content: '这条已经处理过了' } };
  delete state.staged[chatId];
  await saveState();

  for (const upload of st.uploads) {
    try {
      fs.unlinkSync(upload.path);
    } catch {
      /* 文件可能已经不在了 */
    }
  }

  const session = findSession(st.sessionId);
  return {
    toast: { type: 'success', content: `已撤回 ${st.uploads.length} 个附件，没有发送` },
    card: session ? raw(renderSession(session, chatId)) : raw(homeCard(0, filterOf(chatId))),
  };
}

async function submitFromCard(chatId, sessionId, text) {
  const session = findSession(sessionId || state.bindings[chatId]);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };
  const blocked = readOnlyReason(session);
  if (blocked) return { toast: { type: 'info', content: blocked }, card: raw(renderSession(session, chatId)) };

  const prompt = String(text || '').trim();
  if (!prompt) return { toast: { type: 'error', content: '请输入内容' } };

  // 我们自己的回合还在跑：直接进队列，不要误判成"电脑端持有"
  if (inflight.has(session.id)) {
    const token = randomUUID();
    drafts.set(token, { text: prompt, sessionId: session.id, chatId, at: Date.now() });
    return {
      card: raw(busyChoiceCard({ title: title(session), excerpt: prompt.slice(0, 200), token })),
    };
  }

  // 电脑端（或别的终端）持有这个会话时，绝对不能发。
  // 活着的会话进程都会登记在 ~/.claude/sessions/<pid>.json，
  // 之前没有这道检查，消息发出去会被对方排队然后静默丢弃。
  const owner = findOwners(session.id).find((o) => o.pid !== process.pid);
  if (owner) {
    const token = randomUUID();
    drafts.set(token, { text: prompt, sessionId: session.id, chatId, at: Date.now() });
    return {
      card: raw(
        ownerBusyCard({
          title: title(session),
          excerpt: prompt.slice(0, 200),
          token,
          sessionId: session.id,
          busy: owner.status === 'busy',
          source: owner.entrypoint || owner.kind || '电脑端',
        })
      ),
    };
  }

  if (isBusy(session)) {
    const token = randomUUID();
    drafts.set(token, { text: prompt, sessionId: session.id, chatId, at: Date.now() });
    return {
      card: raw(
        busyChoiceCard({
          title: title(session),
          excerpt: prompt.slice(0, 200),
          token,
        })
      ),
    };
  }

  startRun(chatId, session.id, prompt, { silent: true }).catch((err) =>
    console.error('[run]', err?.message || err)
  );

  // startRun 在第一个 await 之前已经置位 inflight，所以这里能正确显示“运行中”
  return { toast: { type: 'success', content: '已发送' }, card: raw(renderSession(session, chatId)) };
}

/**
 * 会话被电脑端占着时，用户关掉标签页后点「重试」。
 *
 * 不做强制接管：结束别人的进程是破坏性操作，让用户自己在电脑上关标签页更干净。
 * 这里只重新探测一次，空闲了就把存着的那条发出去。
 */
async function retryFromBusy(chatId, token) {
  cleanupDrafts();
  const draft = drafts.get(token);
  if (!draft) return { toast: { type: 'error', content: '这条已经发过了，或者已过期' } };

  const session = findSession(draft.sessionId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };

  invalidateCache();
  const owner = findOwners(session.id).find((o) => o.pid !== process.pid);
  if (owner) {
    return {
      toast: {
        type: 'info',
        content:
          owner.status === 'busy'
            ? '电脑端还在跑，等这一轮结束再点重试'
            : '电脑端还开着这个会话，先在电脑上关掉标签页',
      },
    };
  }

  drafts.delete(token);
  startRun(chatId, session.id, draft.text, { silent: true }).catch((err) =>
    console.error('[run]', err?.message || err)
  );
  return { toast: { type: 'success', content: '已发送' }, card: raw(renderSession(session, chatId)) };
}

/**
 * 手机点「接管」：结束电脑端持有这个会话的 claude 进程，然后直接发。
 *
 * 这是破坏性操作，所以只在用户明确点了按钮时做，绝不自动。
 * 结束别人的进程后，电脑端那个标签页会变成「会话已结束」；重新打开即可
 * 读回手机刚写的内容（文件一直在盘上，不会丢）。
 */
async function takeoverFromBusy(chatId, token) {
  cleanupDrafts();
  const draft = drafts.get(token);
  if (!draft) return { toast: { type: 'error', content: '这条已经处理过了' } };

  const session = findSession(draft.sessionId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };

  invalidateCache();
  const owners = findOwners(session.id).filter((o) => o.pid !== process.pid);

  if (owners.length) {
    for (const o of owners) killPid(o.pid);
    console.warn(`[takeover] ${session.id.slice(0, 8)} 结束电脑端 PID ${owners.map((o) => o.pid).join(',')}`);
    await sleep(800);

    invalidateCache();
    const still = findOwners(session.id).find((o) => o.pid !== process.pid);
    if (still) {
      return {
        toast: {
          type: 'error',
          content: `接管失败：电脑端进程（PID ${still.pid}）还在，可能是扩展自动重启了。先手动关掉电脑上的标签页再重试。`,
        },
      };
    }
  }

  drafts.delete(token);
  startRun(chatId, session.id, draft.text, { silent: true }).catch((err) =>
    console.error('[run]', err?.message || err)
  );
  return { toast: { type: 'success', content: '已接管并发送' }, card: raw(renderSession(session, chatId)) };
}

/** 结束一个进程。Windows 上 process.kill 就是 TerminateProcess，兜底用 taskkill 强杀 */
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false; // 已经退出了
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

async function resolveDraft(chatId, token, immediate) {
  cleanupDrafts();
  const draft = drafts.get(token);
  if (!draft) return { toast: { type: 'error', content: '操作已过期，请重新输入' } };
  drafts.delete(token);

  const session = findSession(draft.sessionId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };

  if (immediate) {
    startRun(chatId, session.id, draft.text, { silent: true }).catch((err) =>
      console.error('[run]', err?.message || err)
    );
  } else {
    enqueue(session.id, draft.text, chatId);
    await saveState();
  }

  return {
    toast: { type: 'success', content: immediate ? '已立即执行' : '已排队' },
    card: raw(renderSession(session, chatId)),
  };
}

// ---------------------------------------------------------------- 文本消息

/**
 * 消息入口。
 *
 * 群聊里机器人是群的创建者，可以撤回别人发的消息——处理完立刻清掉，
 * 让这个群只留下卡片和结果（单聊里没权限，撤回会失败，只记一次日志）。
 */
async function handleIncoming(payload) {
  const { chatId, messageId, chatType } = payload;

  if (chatType === 'group') {
    state.groupChats = state.groupChats || {};
    if (!state.groupChats[chatId]) {
      state.groupChats[chatId] = true;
      saveState().catch(() => {});
    }
  }

  try {
    return await handleIncomingInner(payload);
  } finally {
    // 撤回会在群里留下"群主撤回了 xxx 的一条消息"，比留着更难看的概率更大。
    // 所以默认不动消息，只有用户显式 /clean on 才清理。
    if (chatType === 'group' && messageId && state.clean?.[chatId] === true) {
      channel.deleteMessage(messageId).catch((err) => {
        if (cleanupWarned.has(chatId)) return;
        cleanupWarned.add(chatId);
        console.warn('[cleanup] 撤回群消息失败（需要群主/管理员/创建者）:', err?.message || err);
      });
    }
  }
}

async function handleIncomingInner({ chatId, text, openId, messageId, media, chatType }) {
  let input = String(text || '').trim();
  if (!input && !media) return;

  if (!(await acceptOwner(openId))) {
    console.warn('[msg] 忽略非所有者消息');
    return;
  }

  // 附件不直接发：先下载、暂存，把卡片切到「确认发送」。
  // 发错了能在它开始读之前撤回，不会白跑一轮。
  if (media) {
    const pendingProject = newProjectFor(chatId);
    const session = pendingProject ? null : boundSession(chatId);
    if (!session && !pendingProject) {
      return channel.sendText(chatId, '先打开一个会话（或发 /new 选个目录），再把图片/文件发给我。');
    }

    const saved = await saveUpload(chatId, messageId, media);
    if (saved.error) {
      return channel.sendText(chatId, `附件没下载下来：${saved.error}`);
    }

    const targetKey = session ? session.id : `new:${pendingProject.platform}:${pendingProject.cwd}`;
    const existing = state.staged[chatId];

    // 换会话了：上一批作废，别把两个会话的附件混在一起
    if (existing && existing.sessionId !== targetKey) {
      for (const upload of existing.uploads) {
        try {
          fs.unlinkSync(upload.path);
        } catch {
          /* 已不在 */
        }
      }
      delete state.staged[chatId];
    }

    const entry = state.staged[chatId] || {
      uploads: [],
      text: '',
      sessionId: targetKey,
      cwd: pendingProject?.cwd || '',
      platform: pendingProject?.platform,
      at: Date.now(),
      messageId: null,
    };
    entry.uploads.push(saved);
    entry.at = Date.now();
    state.staged[chatId] = entry;

    console.log(`[msg] ${chatId} :: [${media.type}] ${saved.path}（待确认，共 ${entry.uploads.length} 个）`);

    if (entry.messageId) {
      // 已经有一张确认卡：原地更新附件列表，不再多堆一张
      await channel.patchCard(entry.messageId, stagedCardFor(entry)).catch(() => {});
    } else {
      const res = await sendConsoleCard(chatId, stagedCardFor(entry));
      entry.messageId = res?.data?.message_id || null;
    }
    await saveState();
    return;
  }

  const menuFilter = filterFromMenuText(input);
  const opensList = Boolean(menuFilter) || /^(hi|hello|你好|ping|在吗|列表|\/list|会话|sessions?)$/i.test(input);
  if (opensList) {
    clearTransient(chatId, 'error');
    delete state.newCwd[chatId];
    const filter = menuFilter || filterOf(chatId);
    if (state.pending?.[chatId]) delete state.pending[chatId];
    rememberFilter(chatId, filter);
    state.views[chatId] = { kind: 'home', f: filter };
    if (state.lastChatId !== chatId) state.lastChatId = chatId;
    await saveState();
    return sendConsoleCard(chatId, homeCard(0, filter));
  }

  // 附件批次还在等确认时，命令不能被当成"附件说明"吞掉
  const looksLikeCommand =
    /^\/(?:find|搜索|status|状态|help|帮助|new|新建|files|附件|use|用|drop|丢弃|queue|排队|now|立即|open|打开|close|解绑|notify|通知|clean|清理)(?=\s|$)/i.test(
      input
    );

  // 刚发过附件、还没点发送：这段文字当作附件的说明，而不是另起一条
  const staged = state.staged[chatId];
  const pendingProject = newProjectFor(chatId);
  const stagedMatches = staged?.cwd
    ? staged.cwd === pendingProject?.cwd && (staged.platform || 'claude-code') === pendingProject?.platform
    : staged?.sessionId === boundSession(chatId)?.id;
  if (staged && stagedMatches && !looksLikeCommand) {
    const st = state.staged[chatId];
    st.text = st.text ? `${st.text}\n${input}` : input;
    st.at = Date.now();
    await saveState();
    console.log(`[msg] ${chatId} :: 附件说明 :: ${input.slice(0, 80)}`);
    if (st.messageId) await channel.patchCard(st.messageId, stagedCardFor(st)).catch(() => {});
    return;
  }

  console.log(`[msg] ${chatId} :: ${input.slice(0, 80)}`);

  if (state.lastChatId !== chatId) {
    state.lastChatId = chatId;
    await saveState();
  }

  // 等待选择「立即 / 排队」
  const pending = state.pending[chatId];
  if (pending) {
    if (Date.now() - pending.at > PENDING_TTL_MS) {
      delete state.pending[chatId];
      await saveState();
    } else if (/^(1|立即|插入|now)$/i.test(input)) {
      delete state.pending[chatId];
      await saveState();
      await startRun(chatId, pending.sessionId, pending.text);
      return;
    } else if (/^(2|排队|等待|queue)$/i.test(input)) {
      delete state.pending[chatId];
      enqueue(pending.sessionId, pending.text, chatId);
      await saveState();
      return showSession(chatId, findSession(pending.sessionId), true);
    } else {
      delete state.pending[chatId];
      await saveState();
    }
  }

  const findMatch = input.match(/^\/(?:find|搜索)\s*([\s\S]*)$/i);
  if (findMatch) {
    return showSearch(chatId, findMatch[1].trim());
  }

  const openMatch = input.match(/^\/(?:open|打开)\s+(.+)$/i);
  if (openMatch) {
    const session = findSession(openMatch[1].trim());
    if (!session) return channel.sendText(chatId, `没找到「${openMatch[1].trim()}」。`);
    delete state.newCwd[chatId];
    delete state.pending[chatId];
    state.bindings[chatId] = session.id;
    state.views[chatId] = { kind: 'session', s: session.id };
    delete state.unread[session.id];
    msgPages.set(chatId, 0);
    expandedMessages.delete(chatId);
    await saveState();
    startHeartbeat(chatId, session.id);
    return sendConsoleCard(chatId, renderSession(session, chatId));
  }

  if (/^\/(?:close|unbind|解绑|关闭)$/i.test(input)) {
    delete state.bindings[chatId];
    delete state.newCwd[chatId];
    state.views[chatId] = { kind: 'home', f: filterOf(chatId) };
    await saveState();
    // 文字命令发起的导航：直接在底部发一张新卡，别让用户往上翻
    return sendConsoleCard(chatId, homeCard(0, filterOf(chatId)));
  }

  if (/^\/(?:status|状态)$/i.test(input)) {
    return sendTransient(
      chatId,
      'status',
      statusCard({
        pid: process.pid,
        uptime: clock(Date.now() - BOOT_AT),
        sessions: everySession().length,
        bindings: Object.keys(state.bindings || {}).length,
        queues: Object.values(state.queues || {}).reduce((n, q) => n + (q?.length || 0), 0),
        errors: errorCount,
        startedAt: new Date(BOOT_AT).toLocaleString('zh-CN', { hour12: false }),
      })
    );
  }

  const queueMatch = input.match(/^\/(?:queue|排队)\s+([\s\S]+)$/i);
  if (queueMatch) {
    const session = boundSession(chatId);
    if (!session) return noBinding(chatId);
    const blocked = readOnlyReason(session);
    if (blocked) return channel.sendText(chatId, blocked);
    enqueue(session.id, queueMatch[1].trim(), chatId);
    await saveState();
    return showSession(chatId, session, true);
  }

  const nowMatch = input.match(/^\/(?:now|立即)\s+([\s\S]+)$/i);
  if (nowMatch) {
    const session = boundSession(chatId);
    if (!session) return noBinding(chatId);
    const blocked = readOnlyReason(session);
    if (blocked) return channel.sendText(chatId, blocked);
    const text = nowMatch[1].trim();

    if (isBusy(session)) {
      // 正在跑：不打断（打断等于丢一轮），但排到队首
      if (!state.queues[session.id]) state.queues[session.id] = [];
      state.queues[session.id].unshift({ text, chatId, at: Date.now() });
      await saveState();
      return channel.sendText(chatId, '已排到队首，这一轮结束后立刻执行。');
    }
    return startRun(chatId, session.id, text);
  }

  // 附件是落在本机的普通文件，任何会话读到路径都能用。
  // 会话自己不知道别的会话收过什么，所以由桥记一份索引，按序号取回。
  if (/^\/(?:help|帮助|\?)$/i.test(input)) {
    return sendTransient(chatId, 'help', helpCard());
  }

  const newMatch = input.match(/^\/(?:new|新建)(?:\s+(claude(?:[- ]code)?|codex|deepseek))?$/i);
  if (newMatch) {
    const platform = filterFromMenuText(newMatch[1]) || 'claude-code';
    delete state.newCwd[chatId];
    state.views[chatId] = { kind: 'new', p: platform };
    await saveState();
    return sendConsoleCard(chatId, newSessionCardFor(platform));
  }

  const cleanMatch = input.match(/^\/(?:clean|清理)\s+(on|off)$/i);
  if (cleanMatch) {
    if (!state.clean) state.clean = {};
    state.clean[chatId] = cleanMatch[1].toLowerCase() === 'on';
    await saveState();
    return channel.sendText(
      chatId,
      state.clean[chatId]
        ? '已开启：你发的群消息处理完会被撤回。注意飞书会在群里留一行"撤回了一条消息"的提示。'
        : '已关闭清理：消息保留，改用 ✅ 回执标记"已收到"。'
    );
  }

  const notifyMatch = input.match(/^\/(?:notify|通知)\s+(on|off)$/i);
  if (notifyMatch) {
    if (!state.notify) state.notify = {};
    state.notify[chatId] = notifyMatch[1].toLowerCase() === 'on';
    await saveState();
    return channel.sendText(chatId, `完成摘要已${state.notify[chatId] ? '开启' : '关闭'}。`);
  }

  if (/^\/(?:queue|排队)$/i.test(input)) {
    const session = boundSession(chatId);
    if (!session) return noBinding(chatId);
    return showQueue(chatId);
  }

  if (/^\/(?:drop|丢弃|取消附件)$/i.test(input)) {
    const st = state.staged[chatId];
    if (!st) return channel.sendText(chatId, '没有待发送的附件。');

    for (const upload of st.uploads) {
      try {
        fs.unlinkSync(upload.path);
      } catch {
        /* 已经不在了 */
      }
    }
    const count = st.uploads.length;
    delete state.staged[chatId];
    await saveState();

    // 确认卡就是控制台卡：切回会话视图，别让它继续显示一批已作废的附件
    const session = st.cwd ? null : findSession(st.sessionId);
    if (session) {
      state.views[chatId] = { kind: 'session', s: session.id };
      await saveState();
      await sendConsoleCard(chatId, renderSession(session, chatId));
    } else {
      await channel.sendText(chatId, `已丢弃 ${count} 个附件。`);
    }
    return;
  }

  if (/^\/(?:files|附件|文件)$/i.test(input)) {
    const session = boundSession(chatId);
    return channel.sendText(chatId, uploadsText(session ? session.id : null));
  }

  const useMatch = input.match(/^\/(?:use|用)\s+(\d+)$/i);
  if (useMatch) {
    const session = boundSession(chatId);
    if (!session) return noBinding(chatId);
    const upload = pickUpload(session.id, Number(useMatch[1]));
    if (!upload) return channel.sendText(chatId, '序号不对，先发 /files 看列表。');
    if (!fs.existsSync(upload.path)) {
      return channel.sendText(chatId, `「${upload.name}」已经不在了，重新发一次吧。`);
    }
    return startRun(chatId, session.id, mediaPrompt(upload, ''));
  }

  // 选好了项目、还没发第一条：这条文字就是新会话的开口
  if (pendingProject) {
    return startFreshRun(chatId, input, pendingProject, messageId);
  }

  const session = boundSession(chatId);
  if (!session) return noBinding(chatId);
  const blocked = readOnlyReason(session);
  if (blocked) return channel.sendText(chatId, blocked);

  if (isBusy(session)) {
    // 不再问「立即插入还是排队」：默认排队，少一次交互。
    // 想优先执行用 /now 内容（排到队首，结束立刻跑）。
    // 反馈用表情而不是新消息，避免聊天被"已排队"刷屏。
    enqueue(session.id, input, chatId);
    await saveState();
    return reactOrText(chatId, messageId, 'OK', `「${title(session)}」正在跑，已排队，本轮结束自动发送。`);
  }

  return startRun(chatId, session.id, input, { sourceMessageId: messageId });
}

// ---------------------------------------------------------------- 执行与排队

async function startRun(chatId, sessionId, text, options = {}) {
  const session = findSession(sessionId);
  if (!session) return channel.sendText(chatId, '目标会话已不存在，重新打开一次。');
  const blocked = readOnlyReason(session);
  if (blocked) {
    if (options.silent) return;
    return channel.sendText(chatId, blocked);
  }

  // 发消息时回到最新一页，保证能立刻看到自己这条和进度
  msgPages.set(chatId, 0);
  runSteps.delete(session.id);
  // 上一轮的报错已经翻篇了，撤掉，别让它一直挂在聊天里
  clearTransient(chatId, 'error');

  if (inflight.has(session.id)) {
    enqueue(session.id, text, chatId);
    await saveState();
    return channel.sendText(chatId, '这条会话刚被占用，已排队。');
  }

  // 文本消息和队列都会直接走到这里，不像卡片那样先经过 submitFromCard 的拦截。
  // 这里兜底一次：电脑端握着这个会话就不发，否则消息会被对方静默丢弃。
  const owner = findOwners(session.id).find((o) => o.pid !== process.pid);
  if (owner) {
    const token = randomUUID();
    drafts.set(token, { text, sessionId: session.id, chatId, at: Date.now() });
    // 直接顶掉当前那张控制台卡片，不要在聊天里再多一张
    await patchConsoleOrSend(
      chatId,
      ownerBusyCard({
        title: title(session),
        excerpt: text.slice(0, 200),
        token,
        sessionId: session.id,
        busy: owner.status === 'busy',
        source: owner.entrypoint || owner.kind || '电脑端',
      })
    );
    return;
  }

  inflight.add(session.id);
  runStartedAt.set(session.id, Date.now());
  phoneTurns.set(session.id, Date.now()); // 标记：这一轮是手机发起的，完成时给摘要
  lastPartial.delete(session.id);

  // 收到就先给个回执，不用等消息落进 transcript（那要好几秒）
  if (options.sourceMessageId) {
    channel.addReaction(options.sourceMessageId, 'THUMBSUP').catch(() => {});
  }

  startHeartbeat(chatId, session.id);
  console.log(`[run] ${session.project} :: ${title(session)} :: ${text.slice(0, 60)}`);

  if (!options.silent) {
    await showSession(chatId, session);
  }

  // 记下发送前的文件长度，跑完用来验证"这条到底落没落进会话"
  const sizeBefore = fileSize(session.file);

  // 运行期间每 3 秒巡逻：如果电脑端中途接手（重开了标签页），立刻停下自己，
  // 避免两边同时往同一个会话里写。
  let childPid = null;
  let takenOver = null;
  const patrol = setInterval(() => {
    if (!childPid || takenOver) return;
    const other = findOwners(session.id).find((o) => o.pid !== childPid && o.pid !== process.pid);
    if (!other) return;
    takenOver = other;
    console.warn(`[patrol] ${session.id.slice(0, 8)} 被 PID ${other.pid} 接手，终止本轮`);
    try {
      process.kill(childPid);
    } catch {
      /* 已经退出了 */
    }
  }, 3000);
  patrol.unref?.();

  let result;
  try {
    // 限流/网络这类临时错误自动重试一次；其它错误直接报
    for (let attempt = 0; ; attempt++) {
      result = await runSession({
      platform: platformOf(session),
      sessionId: session.id,
      agentPreset: session.agentPreset,
      file: session.file,
      cwd: session.cwd,
      projectDir: session.projectDir,
      prompt: text,
      onSpawn: (pid) => {
        childPid = pid;
        runningChild.set(session.id, pid);
      },
      // 边生成边显示：模型每吐一段文字就记下来，卡片下一秒刷新就能看到
      onEvent: (ev) => {
        if (ev?.type !== 'stream_event') return;
        const e = ev.event;

        if (e?.type === 'message_start') {
          // 上一条已经写进 transcript，清掉预览避免重复
          streaming.delete(session.id);
          thinkingBuf.delete(session.id);
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          // 只记步数，不记工具名/命令——手机上只想知道"它还在做事"
          runSteps.set(session.id, (runSteps.get(session.id) || 0) + 1);
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          const prev = streaming.get(session.id) || '';
          streaming.set(session.id, (prev + e.delta.text).slice(-8000));
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
          // 没有正文的时候，把"它正在想什么"当作可见输出
          const prev = thinkingBuf.get(session.id) || '';
          thinkingBuf.set(session.id, (prev + e.delta.thinking).slice(-4000));
        }
      },
      });

      if (attempt >= 1 || result.code === 0 || result.timedOut || result.noResend || takenOver) break;
      if (!isTransientFailure(result.stderr)) break;
      console.warn('[run] 可重试错误，1.5 秒后自动重试一次');
      await sleep(1500);
    }
  } catch (err) {
    result = { code: -1, stderr: String(err?.message || err), timedOut: false };
  } finally {
    clearInterval(patrol);
    inflight.delete(session.id);
    runStartedAt.delete(session.id);
    streaming.delete(session.id);
    thinkingBuf.delete(session.id);
    runSteps.delete(session.id);
    runningChild.delete(session.id);
    // 不在这里停刷新：用户可能还停在卡片上，之后的电脑端回合也要能实时看到
  }

  const wasCanceled = canceledRuns.delete(session.id);

  if (wasCanceled) {
    phoneTurns.delete(session.id);
    await channel.sendText(chatId, '已停止这一轮。');
  } else if (takenOver) {
    await sendErrorWithRetry(chatId, session, text, {
      title: '电脑端接手了',
      detail:
        `这一轮被电脑端的会话（PID ${takenOver.pid}）接走，手机这边已主动停止，` +
        `避免两边同时写同一个会话。\n在电脑上继续，或等它空下来再发。`,
    });
  } else if (result.timedOut) {
    await sendErrorWithRetry(chatId, session, text, {
      title: '执行超时',
      detail: `「${title(session)}」超过 15 分钟，已终止。`,
    });
  } else if (result.code !== 0) {
    errorCount++;
    const platform = platformOf(session);
    const failure = explainFailure(result.stderr, platform);
    console.error(`[run] ${platform} exit ${result.code}: ${failure.detail}`);
    const notice = { title: failure.title || `${sessionFilterName(platform)} 执行失败`, detail: failure.detail };
    if (failure.retry && !result.noResend) {
      await sendErrorWithRetry(chatId, session, text, notice);
    } else {
      phoneTurns.delete(session.id);
      await sendTransient(chatId, 'error', errorCard({ ...notice, sessionTitle: title(session), sessionId: session.id }));
      return;
    }
  } else if (!result.trustExit && !(await promptLanded(session.file, sizeBefore, text))) {
    // 进程退出码是 0，但会话里没有这句话——正是"被对面接管后静默丢弃"的症状。
    // 不能报成功，否则用户会以为发出去了。
    await sendErrorWithRetry(chatId, session, text, {
      title: '消息没有送进去',
      detail:
        '进程正常退出，但会话里没有出现你这条消息。\n' +
        '如果电脑上还开着这个会话，请关掉对应标签页后再发。',
    });
  } else {
    recordPhoneSend(session.id, text);
    await saveState();
    if (session.agentPreset && platformOf(session) === 'deepseek') {
      await dshStore.scan();
      const updated = findSession(session.id);
      if (updated) await notifyTurnEnd(updated);
    }

    // 手机发来的消息落进会话后，给它挂一个 ✅，不用盯卡片也知道送到了。
    // 只有开了 /clean on（消息会被撤回）时才跳过，否则回执是唯一的"已收到"信号。
    if (options.sourceMessageId && state.clean?.[chatId] !== true) {
      channel
        .addReaction(options.sourceMessageId, 'DONE')
        .catch((err) => console.warn('[reaction] 加回执失败:', err?.message || err));
    }
  }

  drainQueue(session).catch((err) => console.error('[queue]', err?.message || err));
}

async function drainQueue(session) {
  if (inflight.has(session.id)) return;
  const queue = state.queues[session.id];
  if (!queue?.length || readOnlyReason(findSession(session.id) || session)) return;

  const next = queue.shift();
  await saveState();
  await startRun(next.chatId || chatForSession(session.id), session.id, next.text);
}

function enqueue(sessionId, text, chatId) {
  if (!state.queues[sessionId]) state.queues[sessionId] = [];
  state.queues[sessionId].push({ text, chatId, at: Date.now() });
}

// 运行中每秒刷新一次：计时按秒走，新内容最多 1 秒内出现
const PROGRESS_MS = 1000;
const msgPages = new Map(); // chatId -> 页码（0 = 最新一页）
const expandedMessages = new Map(); // chatId -> 当前展开的消息和正文段落

/**
 * 运行期间每秒刷新详情卡：计时按秒走，流式文字也跟着上屏。
 * 只在用户停在当前会话的详情页时才刷；翻到历史页或离开就停。
 */
const heartbeatKey = (chatId, sessionId) => `${chatId}:${sessionId}`;

function startHeartbeat(chatId, sessionId) {
  // 同一个会话可能在两个聊天里同时被看着（群 + 单聊），按"聊天+会话"分开计时
  const key = heartbeatKey(chatId, sessionId);
  stopHeartbeatKey(key);

  let lastKey = '';
  let lastFail = 0;

  const timer = setInterval(() => {
    const current = state.views[chatId];
    if (!current || current.kind !== 'session' || current.s !== sessionId) {
      // 用户已经离开这个会话，留着定时器没意义
      stopHeartbeatKey(key);
      return;
    }

    const session = findSession(sessionId);
    const messageId = state.consoleMessages[chatId];
    if (!session || !messageId) return;

    // 用户翻到历史页时不刷新：内容不会变，刷了只会把人从正在读的位置上推开
    if (msgPageOf(chatId) > 0) return;

    const busy = isBusy(session);
    const suggestions = suggestionsForSession(session, busy);
    // 只看"会显示出来的东西"：工具事件不进卡片，没必要为它重建整张卡
    const human = session.messages.filter((m) => m.kind !== 'tool');
    const latest = human.at(-1);
    const contentKey = `${busy}:${human.length}:${latest?.ts || 0}:${String(latest?.text || '').length}:${session.title}:${session.agentPreset || ''}:${suggestions.map(({ token }) => token).join(',')}`;
    const changed = contentKey !== lastKey;
    // 跑的时候每秒都刷，计时才走得动；
    // 空闲且内容没变就不刷，避免没意义地重建卡片（会抖、会耗电）。
    if (!changed && !busy) return;

    lastKey = contentKey;
    channel
      .patchCard(messageId, renderSession(session, chatId, suggestions))
      .catch((err) => {
        // 每秒刷一次，失败了别把日志刷爆
        if (Date.now() - lastFail < 30_000) return;
        lastFail = Date.now();
        console.warn('[heartbeat] 刷新失败:', err?.message || err);
      });
  }, PROGRESS_MS);

  timer.unref?.();
  heartbeats.set(key, timer);
}

function stopHeartbeatKey(key) {
  const timer = heartbeats.get(key);
  if (timer) clearInterval(timer);
  heartbeats.delete(key);
}


// ---------------------------------------------------------------- 推送

/**
 * 回合结束的提醒。
 *
 * 不发新消息：在用户正在看的那张卡片上原地打红点，再用「应用内加急」
 * 让它弹窗响铃。加急和消息更新都不会在会话里新增一条。
 */
/**
 * 手机发起的回合结束时，额外发一条纯文本摘要。
 * 不点卡片也能知道结果；可以用 /notify off 关掉。
 */
async function maybePhoneSummary(session) {
  if (!phoneTurns.has(session.id)) return;
  phoneTurns.delete(session.id);

  const chatId = chatForSession(session.id);
  // 默认不发摘要：它会在聊天里多出一条消息，把卡片往下顶。需要的人自己 /notify on
  if (!chatId || state.notify?.[chatId] !== true) return;

  // 用户正看着这个会话的卡片：答案已经在卡上，再发一条纯文本只是多一条干扰
  const view = state.views[chatId];
  if (view?.kind === 'session' && view.s === session.id) return;

  const last = session.messages.findLast((m) => m.kind === 'assistant' && m.text);
  const summary = conversationBrief(last?.text, 120);
  if (!summary) return;
  await channel.sendText(chatId, `✅ 「${title(session)}」\n${summary}`);
}

async function notifyTurnEnd(session) {
  const chatId = chatForSession(session.id);
  if (!chatId) return;

  const current = state.views[chatId] || { kind: 'home' };
  const viewingThisOne = current.kind === 'session' && current.s === session.id;

  // 正看着这个会话就不算未读，直接当场刷新成最新
  if (viewingThisOne) delete state.unread[session.id];
  else state.unread[session.id] = Date.now();
  await saveState();

  console.log(`[push] turn:end ${session.project} :: ${title(session)}`);

  const page = await ensureConsoleCard(chatId);
  if (!page) return;

  let card = null;
  if (viewingThisOne && msgPageOf(chatId) === 0) card = renderSession(session, chatId);
  else if (current.kind === 'home') card = homeCard(current.page, current.f || filterOf(chatId));
  else if (current.kind === 'list') card = sessionListCardFor(current.p, current.page);

  if (card) {
    try {
      await channel.patchCard(page.messageId, card);
    } catch (err) {
      console.error('[push] 刷新卡片失败:', err?.message || err);
      // 卡片可能已被撤回或超过 14 天，丢掉这个 message_id，下次重新发一张
      delete state.consoleMessages[chatId];
      await saveState();
    }
  }

  // 最后一句是问句 = 它在等你回答，这种情况要响，不受 10 秒节流限制
  const lastText = [...session.messages].reverse().find((m) => m.kind === 'assistant' && m.text)?.text || '';
  const asksYou = /[?？]\s*$/.test(String(lastText).trim());

  // 弹窗 + 提示音。10 秒内已经响过就不再响，避免多个会话同时完成时连续轰炸
  const last = lastUrgentAt.get(chatId) || 0;
  if (Date.now() - last < 10_000 && !asksYou) return;

  if (state.ownerOpenId) {
    try {
      await channel.urgentApp(page.messageId, [state.ownerOpenId]);
      lastUrgentAt.set(chatId, Date.now());
    } catch (err) {
      console.error('[push] 加急失败（需要在开发者后台加 im:message.urgent 权限）:', err?.message || err);
    }
  }
}

/**
 * 取当前会话里那张可 patch 的卡片。
 * 用户从没发过「列表」时，先补发一张首页卡片当控制台（只发这一次）。
 */
async function ensureConsoleCard(chatId) {
  const existing = state.consoleMessages[chatId];
  if (existing) return { messageId: existing };

  try {
    const res = await sendConsoleCard(chatId, homeCard(0, filterOf(chatId)));
    const messageId = res?.data?.message_id;
    if (!messageId) return null;
    state.views[chatId] = { kind: 'home', f: filterOf(chatId) };
    await saveState();
    return { messageId };
  } catch (err) {
    console.error('[push] 发送控制台卡片失败:', err?.message || err);
    return null;
  }
}

/**
 * 发一张一次性卡片（错误、等待接管之类）。
 *
 * 同类卡片只保留一张：发新的之前先撤回旧的，否则聊天里会堆一长串
 * 早就没用的卡片，还会让人误以为"那张卡不刷新"。
 */
async function sendTransient(chatId, kind, card) {
  const previous = state.transients?.[chatId]?.[kind];
  const res = await channel.sendCard(chatId, card);
  const messageId = res?.data?.message_id;
  if (!messageId) return res;

  state.transients[chatId] = { ...(state.transients[chatId] || {}), [kind]: messageId };
  await saveState();

  if (previous && previous !== messageId) {
    channel.deleteMessage(previous).catch(() => {});
  }
  return res;
}

/** 删掉某个一类性卡片，并从登记表移除 */
function clearTransient(chatId, kind) {
  const id = state.transients?.[chatId]?.[kind];
  if (!id) return;

  delete state.transients[chatId][kind];
  saveState().catch(() => {});
  channel.deleteMessage(id).catch(() => {});
}

/** 错误卡 + 「重发上一条」按钮 */
function sendErrorWithRetry(chatId, session, text, { title: errorTitle, detail }) {
  phoneTurns.delete(session.id);
  const token = randomUUID();
  drafts.set(token, { text, sessionId: session.id, chatId, at: Date.now() });
  return sendTransient(chatId, 'error', errorCard({
    title: errorTitle, detail, retryToken: token, sessionTitle: title(session), sessionId: session.id,
  }));
}

/** 错误卡上的「重发上一条」 */
async function retrySend(chatId, token) {
  cleanupDrafts();
  const draft = drafts.get(token);
  if (!draft) {
    const session = boundSession(chatId);
    return {
      toast: { type: 'info', content: '重发已过期，可重新输入消息。' },
      card: raw(session ? renderSession(session, chatId) : homeCard(0, filterOf(chatId))),
    };
  }
  if (draft.chatId !== chatId) return { toast: { type: 'error', content: '重发已过期' } };
  drafts.delete(token);

  const session = findSession(draft.sessionId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };
  const blocked = readOnlyReason(session);
  if (blocked) return { toast: { type: 'info', content: blocked }, card: raw(renderSession(session, chatId)) };

  await openCard(chatId, session.id);
  startRun(chatId, session.id, draft.text, { silent: true }).catch((err) =>
    console.error('[run]', err?.message || err)
  );
  return { toast: { type: 'success', content: '已重发' }, card: raw(renderSession(session, chatId)) };
}

/** 「停止」：结束当前这一轮，标记为主动取消，不弹错误卡 */
async function stopRun(chatId, options = {}) {
  const view = state.views[chatId];
  const session = findSession(view?.s) || boundSession(chatId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };

  const pid = runningChild.get(session.id);
  if (!pid) return { toast: { type: 'info', content: '这个会话现在没有在跑' } };

  const queueCount = (state.queues[session.id] || []).length;
  // 队列里还有东西：先问一句，免得"停下来修个错"结果队列接着把旧的跑完
  if (queueCount && !options.confirmed && !options.clearQueue) {
    return { card: raw(stopAskCard({ queueCount })) };
  }
  if (options.clearQueue) {
    delete state.queues[session.id];
    await saveState();
  }

  // 保留已经生成的文字，停下来也能看到干到哪了
  const partial = streaming.get(session.id);
  if (partial) lastPartial.set(session.id, partial.slice(-1500));
  else lastPartial.delete(session.id);

  canceledRuns.add(session.id);
  killPid(pid);
  console.warn(`[stop] ${session.id.slice(0, 8)} 用户手动停止 PID ${pid}`);
  return {
    toast: { type: 'success', content: options.clearQueue ? `已停止，清空 ${queueCount} 条队列` : '已停止' },
    card: raw(renderSession(session, chatId)),
  };
}

/** 队列卡片：看、单条取消、清空 */
async function showQueue(chatId) {
  const view = state.views[chatId];
  const session = findSession(view?.s) || boundSession(chatId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };

  return { card: raw(queueCard({ title: title(session), items: state.queues[session.id] || [] })) };
}

async function cancelQueueItem(chatId, index) {
  const view = state.views[chatId];
  const session = findSession(view?.s) || boundSession(chatId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };

  const queue = state.queues[session.id] || [];
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
    return { toast: { type: 'info', content: '这一条已经不在了' } };
  }

  queue.splice(index, 1);
  if (!queue.length) delete state.queues[session.id];
  await saveState();
  return {
    toast: { type: 'success', content: '已取消一条' },
    card: raw(queueCard({ title: title(session), items: queue })),
  };
}

/** 把队列里的某一条提到最前面 */
async function topQueueItem(chatId, index) {
  const view = state.views[chatId];
  const session = findSession(view?.s) || boundSession(chatId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };

  const queue = state.queues[session.id] || [];
  if (!Number.isInteger(index) || index <= 0 || index >= queue.length) {
    return { toast: { type: 'info', content: '这一条已经在最前面了' } };
  }

  const [item] = queue.splice(index, 1);
  queue.unshift(item);
  await saveState();
  return {
    toast: { type: 'success', content: '已置顶' },
    card: raw(queueCard({ title: title(session), items: queue })),
  };
}

/** 搜索会话：标题 / 项目 / 路径 / 最近消息 */
async function showSearch(chatId, keyword) {
  if (!keyword) return sendTransient(chatId, 'search', searchAskCard());

  const kw = keyword.toLowerCase();
  const now = Date.now();
  const results = allSessions()
    .filter((s) => !isProbeSession(s))
    .map((s) => {
      const hay = [
        title(s),
        s.project,
        s.cwd,
        s.lastPrompt,
        ...[...s.messages].reverse().slice(0, 6).map((m) => m.text),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(kw) ? s : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)
    .map((s) => ({
      id: s.id,
      title: title(s),
      project: s.project || '',
      updatedText: ago(now - s.updatedAt),
    }));

  return sendTransient(chatId, 'search', searchCard({ keyword, results }));
}

function newSessionCardFor(platform) {
  const directories = [...new Set(sessionsOf(platform).map((s) => s.cwd).filter(Boolean))];
  const projects = directories.filter((cwd) => {
    try {
      return fs.statSync(cwd).isDirectory();
    } catch {
      return false;
    }
  }).slice(0, 6).map((cwd) => ({ cwd, name: path.basename(cwd) || cwd }));
  return newSessionCard({ projects, platform });
}

function newProjectFor(chatId) {
  const saved = state.newCwd[chatId];
  return typeof saved === 'string' ? { cwd: saved, platform: 'claude-code' } : saved;
}

/** 新建会话前先选项目目录 */
async function chooseNewProject(chatId, cwd, requestedPlatform) {
  if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    return { toast: { type: 'error', content: '目录不存在' } };
  }

  const selected = normalizeListFilter(requestedPlatform);
  const platform = selected === 'all' ? 'claude-code' : selected;
  state.newCwd[chatId] = { cwd, platform };
  state.views[chatId] = { kind: 'new', p: platform };
  await saveState();
  return { toast: { type: 'success', content: `已选 ${path.basename(cwd)}，发一条消息开始 ${sessionFilterName(platform)} 会话` } };
}

/** 在指定目录新建一个会话：跑完第一句后找到 session_id 并绑定 */
async function startFreshRun(chatId, text, { cwd, platform = 'claude-code' }, sourceMessageId) {
  delete state.newCwd[chatId];
  const startView = state.views[chatId];
  await saveState();

  if (sourceMessageId) {
    channel.addReaction(sourceMessageId, 'THUMBSUP').catch(() => {});
  }
  const platformName = sessionFilterName(platform);
  await channel.sendText(chatId, `正在 ${path.basename(cwd)} 新建 ${platformName} 会话，稍等…`);

  let sessionId = '';
  let result;
  try {
    result = await runFresh({
      platform,
      cwd,
      prompt: text,
      onEvent: (ev) => {
        if (sessionId) return;
        const id = ev?.session_id || ev?.message?.session_id ||
          (ev?.type === 'session' && ev.sessionId) || (ev?.type === 'thread.started' && ev.thread_id);
        if (id) sessionId = String(id);
      },
    });
  } catch (err) {
    result = { code: -1, stderr: String(err?.message || err), timedOut: false };
  }

  // 部分 CLI 在首轮失败后仍会留下会话。绑定已保存的会话可让用户在同一条里重试。
  let session = sessionId ? findSession(sessionId) : null;
  if (sessionId && !session) {
    const sessionStore = platform === 'codex' ? codexStore : platform === 'deepseek' ? dshStore : store;
    await sessionStore.scan().catch(() => {});
    session = findSession(sessionId);
  }

  if (result.code !== 0) {
    const failure = explainFailure(result.stderr, platform);
    console.error(`[run] ${platform} exit ${result.code}: ${failure.detail}`);
    if (session) {
      if (state.views[chatId] === startView) {
        state.bindings[chatId] = session.id;
        await showSession(chatId, session);
      }
      return sendTransient(chatId, 'error', errorCard({
        title: `${platformName} 已建会话，首轮未完成`,
        detail: result.timedOut ? '首轮执行超时。可打开这条会话继续。' : failure.detail,
        sessionTitle: title(session),
        sessionId: session.id,
      }));
    }
    if (state.views[chatId] === startView && !state.newCwd[chatId]) {
      state.newCwd[chatId] = { cwd, platform };
      await saveState();
    }
    return sendTransient(chatId, 'error', errorCard({
      title: failure.title || `新建 ${platformName} 会话失败`,
      detail: failure.detail,
    }));
  }

  // 等 transcript 扫描到新文件
  for (let i = 0; !session && sessionId && i < 30; i++) {
    await sleep(300);
    session = findSession(sessionId);
  }

  if (!session) {
    return sendTransient(chatId, 'error', errorCard({
      title: '会话建好了但没找到',
      detail: `${platformName} 已经跑完，会话记录还没读到。稍后发「列表」查看。`,
    }));
  }

  recordPhoneSend(session.id, text);
  if (sourceMessageId && state.clean?.[chatId] !== true) {
    channel.addReaction(sourceMessageId, 'DONE').catch(() => {});
  }
  if (state.views[chatId] !== startView) {
    await saveState();
    return sendTransient(chatId, 'finished', sessionNoticeCard({
      title: `${platformName} 会话已创建`,
      detail: conversationBrief(session.messages.findLast((m) => m.kind === 'assistant')?.text, 120) || '可打开会话查看。',
      sessionTitle: title(session),
      sessionId: session.id,
    }));
  }
  state.bindings[chatId] = session.id;
  msgPages.set(chatId, 0);
  await saveState();

  return showSession(chatId, session);
}

async function clearQueue(chatId) {
  const view = state.views[chatId];
  const session = findSession(view?.s) || boundSession(chatId);
  if (!session) return { toast: { type: 'error', content: '会话不存在' } };

  const count = (state.queues[session.id] || []).length;
  delete state.queues[session.id];
  await saveState();
  return {
    toast: { type: 'success', content: `已清空 ${count} 条` },
    card: raw(renderSession(session, chatId)),
  };
}

async function quickSend(chatId, { s: sessionId, m: replyId, t: token }) {
  const session = boundSession(chatId);
  if (!session) return { toast: { type: 'error', content: '先打开一个会话' } };
  const turns = conversationTurns(session.messages);
  const reply = turns.at(-1)?.at(-1);
  if (session.id !== sessionId || reply?.kind !== 'assistant' || messageId(reply) !== replyId || typeof token !== 'string') {
    return { toast: { type: 'info', content: '建议已更新，请打开当前会话再试' } };
  }
  const blocked = readOnlyReason(session);
  if (blocked) return { toast: { type: 'info', content: blocked }, card: raw(renderSession(session, chatId)) };
  if (isBusy(session)) return { toast: { type: 'info', content: '当前会话还在运行，请等回复完成' } };

  const suggestion = sessionSuggestions.read(session.id, suggestionContext(turns)).find((item) => item.token === token);
  if (!suggestion) return { toast: { type: 'info', content: '建议已更新，请刷新会话' } };

  return submitFromCard(chatId, session.id, suggestion.text);
}

/** 卡片被点过并被原地替换：只摘登记，不撤回 */
function forgetTransient(chatId, messageId) {
  const map = state.transients?.[chatId];
  if (!map || !messageId) return;

  let changed = false;
  for (const [kind, id] of Object.entries(map)) {
    if (id === messageId) {
      delete map[kind];
      changed = true;
    }
  }
  if (changed) saveState().catch(() => {});
}

/** 发一张卡片并记住它的 message_id，之后就能静默 patch */
async function sendConsoleCard(chatId, card) {
  const previous = state.consoleMessages[chatId];
  const res = await channel.sendCard(chatId, card);
  const messageId = res?.data?.message_id;
  if (messageId) {
    state.consoleMessages[chatId] = messageId;
    await saveState();

    // 旧卡片从此不再更新，留在聊天里只会让人以为"没刷新"，直接撤回。
    // 不再自动 Pin：每次换卡都会在聊天里留下"Pin 了这条消息 / 移除了置顶内容"的系统提示。
    if (previous && previous !== messageId) {
      channel.deleteMessage(previous).catch(() => {});
    }
  }
  return res;
}

// ---------------------------------------------------------------- 视图

/** 会话属于哪个平台。目前只有 Claude Code 真正接入。 */
function platformOf(session) {
  return session.platform || 'claude-code';
}

/** 某个平台下的全部会话 */
/** 临时目录里跑出来的探针会话不进列表（之前测试留下的垃圾） */
function isProbeSession(session) {
  const cwd = String(session.cwd || '').toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  return Boolean(cwd && (cwd.startsWith(tmp) || cwd.includes('\\temp\\') || cwd.includes('\\tmp\\')));
}

function sessionsOf(platformId) {
  if (platformId === 'claude-code') return allSessions().filter((s) => !isProbeSession(s));
  if (platformId === 'codex') return codexStore.list();
  if (platformId === 'deepseek') return dshStore.list();
  return [];
}

function everySession() {
  return [
    ...sessionsOf('claude-code'),
    ...sessionsOf('codex'),
    ...sessionsOf('deepseek'),
  ];
}

function homeCard(requestedPage, filter = 'all') {
  const selected = normalizeFilter(filter);
  const sessions = selected === 'all' ? everySession() : sessionsOf(selected);
  const name = sessionFilterName(selected);
  return buildSessionList(sessions, {
    platformName: name,
    platformId: 'all',
    page: requestedPage,
    unified: true,
    withSource: selected === 'all',
    filter: selected,
  });
}

function normalizeFilter(value) {
  return normalizeListFilter(value);
}

function filterOf(chatId) {
  return normalizeFilter(state.listFilter?.[chatId]);
}

function rememberFilter(chatId, requested) {
  const filter = requested == null || requested === '' ? filterOf(chatId) : normalizeFilter(requested);
  if (!state.listFilter) state.listFilter = {};
  if (state.listFilter[chatId] !== filter) {
    state.listFilter[chatId] = filter;
    saveState();
  }
  return filter;
}

function sessionListCardFor(platformId, requestedPage) {
  const platform = findPlatform(platformId);
  return buildSessionList(sessionsOf(platformId), {
    platformName: platform?.name || platformId,
    platformId,
    page: requestedPage,
  });
}

function buildSessionList(sessions, { platformName, platformId, page: requestedPage, unified = false, withSource = false, filter = 'all' }) {
  const now = Date.now();
  const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const page = clampPage(requestedPage, pages);

  const items = ordered
    .slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
    .map((s) => ({
      id: s.id,
      title: title(s),
      source: withSource ? findPlatform(platformOf(s))?.name || platformOf(s) : '',
      project: usefulProject(s.project),
      updatedText: ago(now - s.updatedAt),
      messageCount: s.messages.length,
      readOnly: Boolean(readOnlyReason(s)),
      busy: isBusy(s),
      runningText: (() => {
        const startedAt = runStartedAt.get(s.id);
        if (!startedAt || !isBusy(s)) return '';
        const steps = runSteps.get(s.id) || 0;
        return `${clock(now - startedAt)}${steps ? ` · 第 ${steps} 步` : ''}`;
      })(),
      unread: Boolean(state.unread[s.id]),
      latestText: conversationBrief(s.messages.findLast((m) => m.kind === 'assistant' && m.text)?.text),
    }));

  return sessionListCard({
    platformName,
    platformId,
    items,
    page,
    pages,
    total: ordered.length,
    unified,
    filter,
  });
}

function clampPage(value, pages) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), pages - 1);
}

function suggestionsForSession(session, busy, turns = conversationTurns(session.messages)) {
  if (busy || readOnlyReason(session)) return [];
  const context = suggestionContext(turns);
  sessionSuggestions.request(session.id, context);
  return sessionSuggestions.read(session.id, context);
}

function renderSession(session, chatId, suggestions) {
  const now = Date.now();
  const platformId = platformOf(session);
  const startedAt = runStartedAt.get(session.id);
  const busy = isBusy(session);
  const turns = conversationTurns(session.messages);
  const maxPage = maxMsgPage(session, turns);
  const page = Math.min(chatId ? msgPageOf(chatId) : 0, maxPage);
  const thinkingOff = Boolean(chatId && state.thinkingOff?.[chatId]);

  // 谁持有这个会话：电脑端进程登记在 ~/.claude/sessions/，我们自己的回合算手机
  const owner = findOwners(session.id).find((o) => o.pid !== process.pid);
  const holder = owner ? '🖥 电脑端' : busy ? '📱 手机' : '⚪ 空闲';

  // 手机上写过东西之后，提醒一句：电脑端要重开标签页才看得到
  const lastPhone = state.phoneSends?.[session.id]?.at;
  const phoneCount = state.phoneSends?.[session.id]?.length || 0;
  const readOnly = readOnlyReason(session);
  const hint = readOnly
    ? ''
    : lastPhone && now - lastPhone < 30 * 60 * 1000
      ? `手机上发的 ${phoneCount} 条已写入会话。电脑端要关掉标签页重开，才能看到它们。`
      : '';

  // 进度从消息流里拆出来，放到卡片顶部
  const rendered = renderMessages(session, turns, busy, startedAt, page, !thinkingOff);
  const progress = rendered.find((m) => m.kind === 'pending') || null;
  const visible = rendered.filter((m) => m.kind !== 'pending');
  const expanded = expandedMessages.get(chatId);

  return sessionCard({
    title: title(session),
    project: session.project,
    platformName: findPlatform(platformId)?.name || platformId,
    statusText: busy ? '🟢 运行中' : '',
    holder,
    runningFor: startedAt ? clock(now - startedAt) : '',
    updatedText: hhmm(session.updatedAt),
    queued: state.queues[session.id]?.length || 0,
    running: busy,
    messages: visible,
    expandedMessage: expanded?.sessionId === session.id ? expanded : null,
    progress,
    stopped: busy ? '' : lastPartial.get(session.id) || '',
    hint,
    page,
    pages: maxPage + 1,
    thinkingOff,
    // 状态色：电脑端占着=橙，运行中=绿，空闲=蓝
    tone: owner ? 'orange' : busy ? 'green' : 'blue',
    suggestions: page === 0 ? suggestions ?? suggestionsForSession(session, busy, turns) : [],
    sessionId: session.id,
    platformId,
    readOnly,
  });
}

function msgPageOf(chatId) {
  return Math.max(0, msgPages.get(chatId) || 0);
}

function maxMsgPage(session, turns = conversationTurns(session.messages)) {
  return Math.max(0, Math.ceil(turns.length / TURNS_PER_PAGE) - 1);
}

function messageId(message) {
  return createHash('sha256').update(JSON.stringify([message.kind, message.ts, message.text, message.occurrence])).digest('hex').slice(0, 16);
}

/**
 * 流水：只给人看人该看的东西。
 *
 * 工具调用/命令不再上卡片——那是日志，不是对话。手机上留下的只有
 * 「你说的话」和「Claude 说的话」，包括它中途的说明。
 */
function renderMessages(session, turns, busy, startedAt, page, showThinking) {
  const out = conversationPage(turns, page).map((m) => {
    const fromPhone = m.kind === 'user' && sentFromPhone(session, m.text);
    return {
      id: messageId(m),
      kind: m.kind,
      from: m.kind === 'user' ? (fromPhone ? 'phone' : 'desktop') : '',
      text: m.parts.map(displayText).join('\n\n'),
      images: m.kind === 'user' ? imageKeysForText(m.text) : [],
      time: hhmm(m.ts),
    };
  });

  // 只在最新一页显示进度；翻旧页时保持静止，不把人刷走
  if (busy && page === 0) {
    // 正在流式生成的文字还没进 transcript，单独作为预览显示
    const partial = streaming.get(session.id) || '';
    // 跑了多久 + 距上次活动多久，两个都固定宽度（mm:ss）。
    // 有流式文字时活动时间按 0 算，否则会显示成"很久没动"
    const lastTs = session.messages.at(-1)?.ts || 0;
    const silent = partial ? 0 : lastTs ? Date.now() - lastTs : 0;
    const think = thinkingBuf.get(session.id) || '';
    // 思考只在"跑了一会儿还没有正文"时出现，且用户可以关掉
    const thinkingVisible =
      showThinking && !partial && think && startedAt && Date.now() - startedAt > 10_000;
    out.push({
      kind: 'pending',
      elapsed: startedAt ? mmss(Date.now() - startedAt) : '',
      idle: mmss(silent),
      steps: runSteps.get(session.id) || 0,
      preview: partial ? clipText(partial, 400) : '',
      // 思考只占一行，避免长推理挤占卡片
      thinking: thinkingVisible ? clipText(think.replace(/\s+/g, ' '), 60) : '',
    });
  }
  return out;
}

/** 固定宽度的分:秒，用来避免每秒刷新时进度行换行 */
function mmss(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const raw = (card) => ({ type: 'raw', data: card });

/** 记录用户当前停在哪个界面，并返回卡片回调响应 */
async function view(chatId, v, card) {
  state.views[chatId] = v;
  await saveState();
  return { card: raw(card) };
}

/** 清空某个平台下所有会话的红点 */
function clearUnread(platformId) {
  for (const session of sessionsOf(platformId)) delete state.unread[session.id];
}

/**
 * 优先复用已有的控制台卡片（原地替换），没有再发新的。
 * 文字命令反复发「列表」也不会在聊天里堆一串卡片。
 */
async function patchConsoleOrSend(chatId, card) {
  const messageId = state.consoleMessages[chatId];
  if (messageId) {
    try {
      await channel.patchCard(messageId, card);
      return;
    } catch (err) {
      console.error('[card] 刷新失败，改为新发一张:', err?.message || err);
      delete state.consoleMessages[chatId];
    }
  }
  return sendConsoleCard(chatId, card);
}

/** 把当前界面切到某个会话，并记住停留位置 */
async function showSession(chatId, session, atBottom = false) {
  if (!session) return;
  state.views[chatId] = { kind: 'session', s: session.id };
  msgPages.set(chatId, 0);
  await saveState();
  // 停在这个会话上就一直盯着，电脑端什么时候跑起来都能及时刷出来
  startHeartbeat(chatId, session.id);
  // 文字命令发起的跳转：发到聊天底部，省得往上翻
  return atBottom
    ? sendConsoleCard(chatId, renderSession(session, chatId))
    : patchConsoleOrSend(chatId, renderSession(session, chatId));
}

/** 没有绑定会话时直接给全部会话，而不是丢一句死文本 */
function noBinding(chatId) {
  if (state.views[chatId]?.kind === 'new') {
    return channel.sendText(chatId, '请先在新建会话卡片上选一个项目目录。');
  }
  state.views[chatId] = { kind: 'home', f: filterOf(chatId) };
  return patchConsoleOrSend(
    chatId,
    homeCard(0, filterOf(chatId))
  );
}

// ---------------------------------------------------------------- 辅助

function allSessions() {
  return [...store.sessions.values()];
}

function findSession(key) {
  const value = String(key || '').trim();
  if (!value) return null;
  const sessions = [
    ...allSessions(),
    ...codexStore.list(),
    ...dshStore.list(),
  ];
  return (
    sessions.find((s) => s.id === value) ||
    sessions.find((s) => s.id.startsWith(value)) ||
    null
  );
}

function readOnlyReason(session) {
  if (!session) return '';
  const platform = platformOf(session);
  if (platform === 'deepseek') return session.subagent ? '这是 DeepSeek 子会话，请在主会话继续。' : '';
  if (platform === 'claude-code' || platform === 'codex') return '';
  const name = findPlatform(platform)?.name || '这个';
  return `「${title(session)}」是 ${name} 会话，目前只能查看，还不能从飞书接着发。`;
}

function boundSession(chatId) {
  const sessionId = state.bindings[chatId];
  const current = state.views[chatId];
  return sessionId && (!current || (current.kind === 'session' && current.s === sessionId)) ? findSession(sessionId) : null;
}

function chatForSession(sessionId) {
  for (const [chatId, bound] of Object.entries(state.bindings)) {
    if (bound === sessionId) return chatId;
  }
  return state.lastChatId;
}

function isBusy(session) {
  if (inflight.has(session.id)) return true;

  // 有活进程拿着这个会话时，以它自己报的 status 为准。
  // 这比"文件刚被写过"准确：我们自己的回合跑完也会刚写过，但那不算忙。
  const owner = findOwners(session.id).find((o) => o.pid !== process.pid);
  if (owner) return owner.status === 'busy';

  // transcript 里已经看到 end_turn → 明确结束了，直接放行。
  // 以前这里无条件看"文件 60 秒内被写过"，导致回合刚结束就发消息会被误判成忙，
  // 弹「立即插入 / 排队」。
  if (session.status !== 'running') return false;

  // 状态还停在 running，但文件很久没动、也没有活进程：多半是进程崩了/被杀
  const touched = Math.max(
    fileMtime(session.file),
    session.lastWriteAt || 0,
    session.updatedAt || 0
  );
  return Date.now() - touched < 60_000;
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 把飞书附件下载到 data/uploads/<chatId>/。
 * 返回 { path, name, type, size }，失败返回 null。
 */
async function saveUpload(chatId, messageId, media) {
  try {
    const dir = path.join(UPLOAD_DIR, String(chatId).replace(/[^\w-]/g, '_'));
    await fsp.mkdir(dir, { recursive: true });

    const fallback = media.type === 'image' ? 'image.png' : 'file.bin';
    const base = safeFileName(media.name || fallback);
    // 精确到毫秒：同一秒内连发两张图不会互相覆盖（以前就撞过，丢了一张）
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    let file = path.join(dir, `${stamp}-${base}`);
    if (fs.existsSync(file)) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      file = path.join(dir, `${stamp}-${stem}-${randomUUID().slice(0, 4)}${ext}`);
    }

    await channel.downloadAttachment(messageId, media, file);

    const size = fileSize(file);
    if (!size) throw new Error('下载到的文件是空的');

    // 飞书图片消息不带扩展名，文件头才是真相。名字错了 Claude 会拒绝读图。
    const finalPath = media.type === 'image' ? fixImageExt(file) : file;

    // 图片再上传一次到飞书，拿 image_key，确认卡里就能直接看到缩略图
    let imageKey = '';
    if (media.type === 'image' && size <= 10 * 1024 * 1024) {
      try {
        imageKey = await channel.uploadImage(await fsp.readFile(finalPath));
      } catch (err) {
        console.warn('[upload] 缩略图上传失败:', err?.message || err);
      }
    }

    return { path: finalPath, name: path.basename(finalPath), type: media.type, size, imageKey };
  } catch (err) {
    const reason = err?.message || String(err);
    console.error('[upload] 下载失败:', reason);
    return { error: reason };
  }
}

/** 按文件头修正图片扩展名（飞书不给扩展名） */
function fixImageExt(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);

    let ext = null;
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) ext = 'png';
    else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ext = 'jpg';
    else if (head.toString('ascii', 0, 3) === 'GIF') ext = 'gif';
    else if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';

    if (!ext || path.extname(file).toLowerCase() === `.${ext}`) return file;

    const target = `${file.slice(0, -path.extname(file).length)}.${ext}`;
    fs.renameSync(file, target);
    return target;
  } catch {
    return file;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 只留文件名，去掉路径分隔符和 Windows 非法字符 */
function safeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'file').slice(0, 80);
}

/**
 * 卡片上显示的文字。
 *
 * 带附件的消息在会话里存的是「路径 + 说明」这种机器可读的提示词，
 * 直接铺到卡片上就是一大串绝对路径。这里还原成人看的样子。
 */
/** 临时性错误（限流/网络）可以自动重试；其它错误重试也是白费 */
function isTransientFailure(text) {
  return /rate.?limit|\b429\b|overloaded|timeout|ETIMEDOUT|ECONNRESET|EPIPE|fetch failed|network/i.test(
    String(text || '')
  );
}

/** 从"附件提示词"里找出对应的图片，用于卡片里直接显示缩略图 */
function imageKeysForText(text) {
  const raw = String(text || '');
  if (!raw.includes('原名') || !state.uploads?.length) return [];

  const keys = [];
  for (const u of state.uploads) {
    if (u.imageKey && raw.includes(u.path)) keys.push(u.imageKey);
  }
  return keys.slice(-3);
}

/** 截断但不改动空白：长回复要保留换行给卡片排版 */
function clipText(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function displayText(text) {
  const raw = String(text || '');

  // 多附件：一行列出所有文件名
  const multi = /^用户从手机发来以下附件（本机绝对路径）：\n([\s\S]*?)\n\n(?:用户的说明：([\s\S]*)|请先读取这些文件[^\n]*)$/.exec(
    raw
  );
  if (multi) {
    const names = [...multi[1].matchAll(/（原名 (.+?) · [^）]*）/g)].map((x) => x[1]);
    const note = (multi[2] || '').trim();
    return `📎 ${names.length ? names.join('、') : '附件'}${note ? `　${note}` : ''}`;
  }

  const m = /^用户从手机发来一个(图片|文件)，已保存到本机：\n(.+)\n（原名 (.+?) · [^）]*）(?:\n\n用户的说明：([\s\S]*))?$/.exec(
    raw
  );
  if (!m) return raw;

  const [, kind, , name, note] = m;
  return `📎 ${name || kind}${note ? `　${note}` : ''}`;
}

/**
 * 附件索引：文件名 + 绝对路径 + 发给哪个会话。
 *
 * 附件是落在本机的普通文件，任何会话拿到路径都能 Read；但会话之间互相
 * 看不见对方的 transcript，A 里收到的路径不会出现在 B 的上下文里。
 * 所以桥记一份「这个文件发给了谁」，B 的 /files 只列发给自己的，
 * 其它会话自然就「看不到、也不会误读」。
 */
function recordUpload(upload, chatId, sessionId) {
  if (!Array.isArray(state.uploads)) state.uploads = [];
  state.uploads.push({
    path: upload.path,
    name: upload.name,
    size: upload.size,
    type: upload.type,
    imageKey: upload.imageKey || '',
    chatId,
    sessionId,
    at: Date.now(),
  });
  if (state.uploads.length > 50) state.uploads.splice(0, state.uploads.length - 50);
  saveState().catch(() => {});
}

/**
 * 能用表情回执就用表情，不行再退回一条文字。
 * 表情不占聊天位置，是"已收到"最轻的反馈。
 */
async function reactOrText(chatId, messageId, emoji, text) {
  if (messageId) {
    try {
      const res = await channel.addReaction(messageId, emoji);
      if (res?.code === undefined || res?.code === 0) return;
    } catch {
      /* 走文字兜底 */
    }
  }
  return channel.sendText(chatId, text);
}

/** 某个会话自己的附件，新的在前 */
function uploadsFor(sessionId) {
  return (state.uploads || [])
    .filter((u) => u.sessionId === sessionId)
    .slice(-10)
    .reverse();
}

function pickUpload(sessionId, n) {
  const list = uploadsFor(sessionId);
  return Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : null;
}

function uploadsText(sessionId) {
  if (!sessionId) return '先打开一个会话，再发 /files 看这个会话的附件。';
  const list = uploadsFor(sessionId);
  if (!list.length) return '这个会话还没有附件。用聊天框的「+」发图片或文件，确认后会出现在这里。';

  const lines = list.map(
    (u, i) =>
      `${i + 1}. 📎 ${u.name} · ${u.type === 'image' ? '图片' : '文件'} · ${shortSpan(Date.now() - u.at)}前`
  );
  return `这个会话的附件：\n${lines.join('\n')}\n\n回复 /use 序号，让当前会话重新读取其中一个。`;
}

/** 附件确认卡和提示词里都要用到的「可读大小」 */
function humanSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * 附件提示词。支持一次带多个文件（手机上发好几张图 + 一句话是常态）。
 * 每个文件都给绝对路径，让 Claude 自己 Read。
 */
function mediaPrompt(uploads, text) {
  const list = Array.isArray(uploads) ? uploads : [uploads];

  if (list.length === 1) {
    const upload = list[0];
    const kind = upload.type === 'image' ? '图片' : '文件';
    const head =
      `用户从手机发来一个${kind}，已保存到本机：\n` +
      `${upload.path}\n` +
      `（原名 ${upload.name} · ${humanSize(upload.size)}）`;
    if (text) return `${head}\n\n用户的说明：${text}`;
    return `${head}\n\n请先读取这个文件，再根据内容回应。`;
  }

  const lines = list.map(
    (u) =>
      `- ${u.type === 'image' ? '图片' : '文件'}：${u.path}（原名 ${u.name} · ${humanSize(u.size)}）`
  );
  const head = `用户从手机发来以下附件（本机绝对路径）：\n${lines.join('\n')}`;
  if (text) return `${head}\n\n用户的说明：${text}`;
  return `${head}\n\n请先读取这些文件，再根据内容回应。`;
}

/** 确认卡的内容：附件清单 + 说明 */
function stagedCardFor(st) {
  const session = st.cwd ? null : findSession(st.sessionId);
  const titleText = st.cwd
    ? `新建 ${sessionFilterName(st.platform || 'claude-code')} 会话 · ${path.basename(st.cwd)}`
    : session ? title(session) : '会话';
  return stagedFileCard({
    title: titleText,
    files: st.uploads.map((u) => ({
      name: u.name,
      sizeText: humanSize(u.size),
      type: u.type,
      imageKey: u.imageKey || '',
    })),
    caption: st.text,
  });
}

function readFrom(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return '';
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 已经关了 */
      }
    }
  }
}

/**
 * 这条消息到底有没有落成会话里的一条用户消息？
 *
 * 这是"石沉大海"的直接判据：进程退出码为 0，但文件里没有这句话，
 * 说明它被对面接管进队列、然后丢掉了。不能当成成功。
 */
async function promptLanded(file, offset, text, waitMs = 4000) {
  const needle = String(text).replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!needle) return true;

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const chunk = readFrom(file, offset);
    if (chunk && landedInChunk(chunk, needle)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 在新增的 JSONL 里找"这条 user 消息进来了没有"。
 *
 * 以前直接对原始文本做 includes，但文件里的 Windows 路径是 JSON 转义的
 * （`G:\\Project\\...`），带路径的提示词永远匹配不上——于是图片消息明明
 * 已经进了会话，卡片还报"消息没有送进去"。
 */
function landedInChunk(chunk, needle) {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 半行（正在写），下一轮再看
    }
    if (rec.type !== 'user') continue;

    const content = rec.message?.content;
    const texts = Array.isArray(content)
      ? content.filter((b) => b?.type === 'text').map((b) => b.text)
      : [content];

    for (const value of texts) {
      if (typeof value === 'string' && value.replace(/\s+/g, ' ').includes(needle)) return true;
    }
  }
  return false;
}

async function acceptOwner(openId) {
  if (state.ownerOpenId && openId && openId !== state.ownerOpenId) return false;
  if (!state.ownerOpenId && openId) {
    state.ownerOpenId = openId;
    await saveState();
    console.log('[owner] 已记录所有者');
  }
  return true;
}

function cleanupDrafts() {
  const now = Date.now();
  for (const [token, draft] of drafts) {
    if (now - draft.at > PENDING_TTL_MS) drafts.delete(token);
  }
}

function title(session) {
  const saved = conversationBrief(session.title);
  if (saved) return saved;
  for (const message of session.messages) {
    if (message.kind !== 'user') continue;
    const brief = conversationBrief(displayText(message.text));
    if (brief) return brief;
  }
  return conversationBrief(displayText(session.lastPrompt)) || usefulProject(session.project) || '未命名会话';
}

/** 3:07 / 1:02:45 */
/** 消息时间戳 → 12:24（手机卡片上用） */
function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 记下这条是手机发出去的 */
function recordPhoneSend(sessionId, text) {
  if (!state.phoneSends) state.phoneSends = {};
  const list = state.phoneSends[sessionId] || (state.phoneSends[sessionId] = []);
  list.push({ t: String(text).replace(/\s+/g, ' ').trim().slice(0, 60), at: Date.now() });
  while (list.length > 20) list.shift();
}

/** 这条用户消息是不是我们（手机）发出去的 */
function sentFromPhone(session, text) {
  const list = state.phoneSends?.[session.id];
  if (!list?.length) return false;
  const needle = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!needle) return false;
  return list.some((e) => e.t && (needle.startsWith(e.t) || e.t.startsWith(needle)));
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 40 秒 / 2 分 10 秒 / 3 分钟 */
function shortSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

function ago(ms) {
  if (!ms || ms < 0) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/**
 * 单实例锁。
 *
 * 飞书长连接是"集群模式"：同一个应用开多个实例时，消息只会随机投给其中一个。
 * 之前 TaskStop 只杀了 shell、留下 node 孤儿进程，结果两个实例抢消息，
 * 手机上点了按钮但日志里什么都没发生。这里直接用 PID 锁把这种情况挡在启动时。
 */
function acquireLock() {
  const lockFile = path.join(STATE_DIR, 'bridge.lock');
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (pid && pid !== process.pid && isProcessAlive(pid)) {
      console.error(
        `已经有守护进程在跑（PID ${pid}）。\n` +
          `飞书长连接是集群模式，两个实例会互相抢消息。\n` +
          `先结束它：taskkill /PID ${pid} /F`
      );
      process.exit(1);
    }
  } catch {
    /* 没有锁文件，正常 */
  }

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid));
  } catch (err) {
    console.warn('[lock] 写锁文件失败，跳过:', err?.message || err);
    return;
  }

  const release = () => {
    try {
      if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockFile);
    } catch {
      /* 已经没了 */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', release);
  process.on('SIGTERM', release);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    saved = {};
  }
  return {
    lastChatId: saved.lastChatId || null,
    ownerOpenId: saved.ownerOpenId || null,
    bindings: saved.bindings || {},
    queues: saved.queues || {},
    pending: saved.pending || {},
    // 卡片是原地更新的，记住每张“控制台”卡片的 message_id 才能事后 patch
    consoleMessages: saved.consoleMessages || {},
    // 用户当前停留在哪一屏，决定推送时要不要原地刷新
    views: saved.views || {},
    // sessionId -> 完成时间，用来画红点
    unread: saved.unread || {},
    // sessionId -> [{t, at}] 手机发出去的消息，用来在流水里标 📱 / 🖥
    phoneSends: saved.phoneSends || {},
    // 手机发来的附件索引：别的会话靠它按序号找回同一份文件
    uploads: saved.uploads || [],
    // 一次性卡片（错误 / 等待接管）的 message_id：每类只留一张
    transients: saved.transients || {},
    // 待确认的附件批次：chatId -> { uploads:[...], text, sessionId, messageId, at }
    staged: saved.staged || {},
    // 某些聊天里用户不想看到模型的思考内容
    thinkingOff: saved.thinkingOff || {},
    // 完成摘要开关：chatId -> boolean（默认开）
    notify: saved.notify || {},
    // 会话总表当前看哪一边：chatId -> all | claude-code | codex | deepseek
    listFilter: saved.listFilter || {},
    // 哪些聊天是群聊
    groupChats: saved.groupChats || {},
    // 是否撤回群里的用户消息（默认关：撤回会留提示，更难看）
    clean: saved.clean || {},
    // 选好了项目、等第一条消息来新建会话：chatId -> cwd
    newCwd: saved.newCwd || {},
  };
}

/**
 * 状态落盘。
 *
 * 以前每次调用都同步写一遍，卡片的每个回调都要等它，
 * 飞书上就表现为"点一下按钮转一圈"。改成合并 + 延迟写：
 * 调用方立刻拿到返回值，磁盘在后面补上；退出时兜底 flush。
 */
let stateDirty = false;
let stateTimer = null;

function saveState() {
  stateDirty = true;
  if (!stateTimer) {
    stateTimer = setTimeout(() => {
      stateTimer = null;
      flushState().catch((err) => console.error('[state]', err?.message || err));
    }, 80);
    stateTimer.unref?.();
  }
  return Promise.resolve();
}

async function flushState() {
  if (!stateDirty) return;
  stateDirty = false;
  try {
    await fsp.mkdir(STATE_DIR, { recursive: true });
    await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    stateDirty = true;
    throw err;
  }
}

Promise.all([store.start(), codexStore.start(), dshStore.start()]).then(() => {
  channel.start();
  resumeHeartbeats();
  console.log(
    `已启动：Claude ${sessionsOf('claude-code').length} 个，Codex ${codexStore.list().length} 个，DeepSeek ${dshStore.list().length} 个，等待飞书消息…`
  );
});

/**
 * 重启后恢复刷新。
 *
 * 定时器在内存里，进程一重启就没了。用户手机上可能正停在某个会话卡上，
 * 不恢复的话那张卡就一直是重启前的样子——这正是"刷新不及时"的来源之一。
 */
function resumeHeartbeats() {
  for (const [chatId, view] of Object.entries(state.views || {})) {
    if (view?.kind !== 'session' || !view.s) continue;
    if (!findSession(view.s)) continue;
    startHeartbeat(chatId, view.s);
  }
}

async function shutdown() {
  store.stop();
  try {
    await flushState();
  } catch {
    /* 尽力而为 */
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
