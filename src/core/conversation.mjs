export const TURNS_PER_PAGE = 10;

export function conversationTurns(messages) {
  const turns = [];
  const occurrences = new Map();
  for (const message of messages) {
    if (message.kind !== 'user' && message.kind !== 'assistant') continue;
    if (message.kind === 'user' || !turns.length) turns.push([]);
    const turn = turns.at(-1);
    const last = turn.at(-1);
    if (message.kind === 'assistant' && last?.kind === 'assistant') {
      last.parts.push(message.text);
    } else {
      const key = JSON.stringify([message.kind, message.ts, message.text]);
      const occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);
      turn.push({ ...message, occurrence, parts: [message.text] });
    }
  }
  return turns;
}

export function conversationPage(turns, page) {
  const end = Math.max(0, turns.length - page * TURNS_PER_PAGE);
  return turns.slice(Math.max(0, end - TURNS_PER_PAGE), end).flat();
}

// Leave room for the ten-round card, controls, and the outer JSON string escaping.
export function messageTextPages(text) {
  const pages = [];
  let start = 0;
  let end = 0;
  let size = 0;
  for (const character of text) {
    const escaped = JSON.stringify(character).slice(1, -1);
    const bytes = Buffer.byteLength(JSON.stringify(escaped)) - 2;
    if (size + bytes > 5000) {
      pages.push(text.slice(start, end));
      start = end;
      size = 0;
    }
    end += character.length;
    size += bytes;
  }
  pages.push(text.slice(start));
  return pages;
}
