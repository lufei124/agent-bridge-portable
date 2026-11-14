/**
 * 把 Claude Code 的原始 JSONL 记录，转成与通道无关的事件。
 *
 * 原始记录类型很多（api-request、attachment、atis-latch…），绝大多数与展示无关。
 * 这里只保留对话相关的事件，其余一律丢弃。
 *
 * 事件形状：
 *   { kind: 'title',    title, ts }
 *   { kind: 'user',     text,  ts, sessionId, cwd }
 *   { kind: 'assistant',text,  ts, sessionId, cwd, stopReason }
 *   { kind: 'tool',     name, summary, ts, sessionId, cwd }
 *   { kind: 'turn_end', ts, sessionId, cwd }
 */

const MAX_TOOL_SUMMARY = 160;

export function normalize(rec) {
  if (!rec || typeof rec !== 'object') return [];
  // 子 agent（sidechain）的消息不进入主会话流水
  if (rec.isSidechain) return [];

  // ai-title / last-prompt 这类记录没有 timestamp，不能拿当前时间冒充，
  // 否则会把所有会话的“最后活跃”刷新成刚刚。
  const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0;
  const meta = { ts, sessionId: rec.sessionId, cwd: rec.cwd };

  switch (rec.type) {
    case 'ai-title':
      return rec.aiTitle ? [{ kind: 'title', title: rec.aiTitle, ...meta }] : [];

    case 'last-prompt':
      return rec.lastPrompt ? [{ kind: 'prompt', text: rec.lastPrompt, ...meta }] : [];

    case 'user':
    case 'assistant':
      return fromMessage(rec, meta);

    default:
      return [];
  }
}

function fromMessage(rec, meta) {
  const msg = rec.message;
  if (!msg) return [];

  const content = msg.content;
  if (typeof content === 'string') {
    if (!content.trim()) return [];
    return [{ kind: rec.type, text: content.trim(), ...meta, stopReason: msg.stop_reason }];
  }
  if (!Array.isArray(content)) return [];

  const out = [];
  const texts = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text && block.text.trim()) {
      texts.push(block.text.trim());
    } else if (block.type === 'tool_use') {
      out.push({
        kind: 'tool',
        name: block.name || 'tool',
        summary: summarizeToolInput(block.input),
        ...meta,
      });
    }
    // thinking / tool_result / image 暂不进手机流水
  }

  if (texts.length) {
    out.unshift({
      kind: rec.type,
      text: texts.join('\n\n'),
      ...meta,
      stopReason: msg.stop_reason,
    });
  }

  if (msg.stop_reason === 'end_turn') {
    out.push({ kind: 'turn_end', ...meta });
  }

  return out;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const candidate =
    input.file_path || input.path || input.command || input.pattern || input.query || input.url;
  if (typeof candidate !== 'string') return '';
  return clip(candidate.replace(/\s+/g, ' '), MAX_TOOL_SUMMARY);
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
