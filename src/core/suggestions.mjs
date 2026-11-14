import { createHash } from 'node:crypto';
import { conversationBrief } from './brief.mjs';

const RECENT_TURNS = 3;
const topics = [
  [/待验证|待确认|还没|尚未|未完成|仍需|还需|pending|not yet|still need/i, '核对', '请说明「%s」还有哪一步没验证，以及如何确认完成。'],
  [/下一步|接下来|后续|建议|可以尝试|next steps?|recommend/i, '看', '请说明「%s」接下来最值得做的一步，以及预期结果。'],
  [/报错|异常|失败|故障|超限|error|failure|failed/i, '查', '请结合前面的回复说明「%s」的原因，以及如何确认问题已解决。'],
  [/测试|验收|验证|回归|\btests?\b|verif(?:y|ied|ication)/i, '核对', '请说明「%s」已经验证了哪些情况，还有哪些需要确认。'],
  [/部署|发布|上线|推送|提交|deploy|release|commit|push/i, '核对', '请说明「%s」目前更新到了哪里，以及如何确认已经生效。'],
  [/配置|权限|设置|登录|config|permissions?|settings?/i, '查看', '请说明「%s」对应的设置在哪里，以及应该核对哪些值。'],
  [/数据|表格|统计|\bdata\b|\btables?\b|statistics/i, '解读', '请说明「%s」里最值得关注的数据或差异。'],
  [/修复|改动|更新|实现|调整|fixed|changed|implemented|updated/i, '了解', '请说明「%s」涉及的主要改动，以及用户能看到的效果。'],
];

function recentLines(text) {
  return text.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*(?=\r?$)|(?![\s\S]))/gm, '')
    .slice(-6000)
    .split(/\r?\n|[。！？；]/)
    .map((line) => conversationBrief(line.replace(/https?:\/\/\S+/gi, ''), 100))
    .filter(Boolean);
}

function subjectOf(line) {
  const named = line.match(/「([^」]{2,28})」|“([^”]{2,28})”|`([\w./-]{2,28})`/);
  if (named) return named.slice(1).find(Boolean);
  const errorCode = /(?:错误码|报错|错误|code|error)\s*[:：#]?\s*(\d{5,6})/i.exec(line);
  if (errorCode) return errorCode[1];
  const product = /(?:\b(?:DeepSeek|Claude(?: Code)?|Codex|GitLab|GitHub|Windows|Harness|Node(?:\.js)?|WebSocket)\b|飞书)[ \t]*(?:仓库拉取|仓库|卡片|会话|配置|权限|连接|表格|长连接|桥接|更新|回复|分页|登录|启动)?/u.exec(line);
  if (product) return product[0].trim();
  const feature = /[\p{Script=Han}]{2,8}(?:按钮|面板|权限|配置|分页|表格|测试|构建|部署|登录)/u.exec(line);
  return feature?.[0].replace(/^(?:目前|已经|仍需|还需|已|未|把|将|的)+/, '') ?? '';
}

export function replySuggestions(turns) {
  const latest = turns.at(-1)?.at(-1);
  if (latest?.kind !== 'assistant' || !latest.parts.some((part) => part.trim())) return [];

  const context = turns.slice(-RECENT_TURNS).reverse();
  const latestLines = recentLines(latest.parts.join('\n\n'));
  if (!latestLines.length) return [];
  const userLines = context.flatMap((turn) => recentLines(turn.find((message) => message.kind === 'user')?.text ?? ''));
  const previousReplies = context.slice(1).flatMap((turn) => recentLines(
    turn.filter((message) => message.kind === 'assistant').flatMap((message) => message.parts).join('\n\n'),
  ));
  const fallback = [...latestLines, ...userLines, ...previousReplies].map(subjectOf).find(Boolean);

  const candidates = [...latestLines, ...previousReplies].flatMap((line, index) => {
    const topic = topics.findIndex(([pattern]) => pattern.test(line));
    if (topic < 0) return [];
    const [, verb, prompt] = topics[topic];
    const subject = subjectOf(line) || (index < latestLines.length ? fallback : '');
    if (!subject) return [];
    const label = Array.from(verb + subject).slice(0, 10).join('');
    const question = prompt.replace('%s', () => subject);
    return [{
      label, subject,
      text: `结合你近期的回复「${line}」，${question}`,
      score: topic + (index < latestLines.length ? 0 : topics.length),
    }];
  });

  const suggestions = [];
  const seen = new Set();
  for (const candidate of candidates.sort((a, b) => a.score - b.score)) {
    if (seen.has(candidate.subject) || suggestions.some(({ label }) => label === candidate.label)) continue;
    seen.add(candidate.subject);
    const { label, text } = candidate;
    const token = createHash('sha256').update(JSON.stringify([label, text])).digest('hex').slice(0, 12);
    suggestions.push({ label, text, token });
    if (suggestions.length === 3) break;
  }
  return suggestions;
}
