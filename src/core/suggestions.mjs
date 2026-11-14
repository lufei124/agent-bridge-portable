import { createHash } from 'node:crypto';

const topics = [
  [/报错|异常|失败|修复|故障|\berror\b|\bfail(?:ure|ed)?\b|\bfix(?:ed)?\b/gi,
    [['看故障原因', '请解释这次问题的原因，以及如何验证已经修复。'], ['查复现条件', '请说明这个问题在什么条件下会出现。']]],
  [/测试|验收|回归|\btests?\b|\bverif(?:y|ied|ication)\b/gi,
    [['看验证结果', '请总结验证覆盖了哪些情况，哪些还没验证。'], ['看边界情况', '这次验证还需要关注哪些边界情况？']]],
  [/部署|发布|上线|推送|提交|分支|仓库|\b(?:git|deploy(?:ed|ment)?|commit(?:ted)?|release)\b/gi,
    [['看变更范围', '请说明受这次变更影响的文件和功能。'], ['看部署状态', '请说明目前发布到哪里了，还有哪些步骤待完成。']]],
  [/代码|脚本|接口|实现|函数|\b(?:code|script|implementation|function|api)\b/gi,
    [['解释实现', '请解释这次实现的关键逻辑。'], ['给使用示例', '请给出一个这项功能的实际使用示例。']]],
  [/设置|配置|权限|账号|密钥|\b(?:setting|config|permission|account)s?\b/gi,
    [['看配置入口', '请说明涉及的设置在哪里查看或修改。'], ['核对配置项', '请列出需要核对的配置项以及各自的用途。']]],
  [/数据|表格|统计|百分比|\b(?:data|table|statistics|percent)\b/gi,
    [['看数据来源', '请说明这些数据的来源和统计口径。'], ['提炼结论', '请概括这组数据最重要的结论。']]],
  [/下一步|建议|方案|选项|可以选择|\b(?:option|recommendation|next step)s?\b/gi,
    [['比较方案', '请比较你提到的方案，并说明各自适用的情况。'], ['看后续步骤', '请把刚才提到的后续步骤按优先级列出来。']]],
];

export function replySuggestions(reply) {
  if (!reply?.trim()) return [];
  const prose = reply.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*(?=\r?$)|(?![\s\S]))/gm, '').slice(-6000);
  const seed = createHash('sha256').update(reply).digest();
  const matches = topics.flatMap(([pattern, options], index) => {
    const last = Array.from(prose.matchAll(pattern)).at(-1);
    return last ? [{ position: last.index, suggestion: options[seed[index] % options.length] }] : [];
  });
  if (!matches.length) {
    return prose.trim().length >= 30 ? [{ label: '提炼要点', text: '请用几句话概括上一条回复的要点。' }] : [];
  }
  return matches.sort((a, b) => b.position - a.position).slice(0, 3)
    .map(({ suggestion: [label, text] }) => ({ label, text }));
}
