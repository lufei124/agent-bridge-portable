const contextBlock = /<(system-reminder|environment_context|timestamp|user_info|user-info|app-context|permissions instructions|collaboration_mode|skills_instructions|subagent_notification|workspace_context|tool_result|command-name|command-message|command-args|local-command-stdout|local-command-caveat)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
const codeBlock = /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|$))?/gm;

export function conversationBrief(text, max = 48) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const request = /^# Files mentioned by the user:\s*\n[\s\S]*?^## My request:[ \t]*\n?/m.exec(source);
  const prose = (request ? source.slice(request.index + request[0].length) : source)
    .replace(contextBlock, '')
    .replace(codeBlock, '');

  for (const line of prose.split('\n')) {
    const sentence = line.trim()
      .replace(/^(?:#{1,6} +|> +|[-*+] +|\d+\. +)/, '')
      .replace(/^(\*{1,2})(.+)\1$/, '$2')
      .trim();
    if (!sentence || /^<\/?[a-z][\w-]*>$/i.test(sentence)) continue;
    if (/^Files mentioned by the user:?$/i.test(sentence)) continue;
    if (/^(?:session-)?[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(sentence) ||
        /^[a-f\d]{8,}$/i.test(sentence)) continue;
    if (/^(?:\d{4}[-/]\d{2}[-/]\d{2}(?:[T ].*)?|\d{1,2}:\d{2}(?::\d{2})?)$/.test(sentence)) continue;
    if (/^(?:\{\s*["']|\[\s*\{|(?:const|let|var|import|export|function)\s+\w|(?:diff --git|@@ |Traceback |at \S+ \())/.test(sentence)) continue;
    if (/^(?:[a-z]:[\\/]|\/\S|https?:\/\/)\S*$/i.test(sentence)) continue;
    if (/^`[^`]+`$/.test(sentence) || !/\p{L}/u.test(sentence)) continue;
    return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence;
  }
  return '';
}

export function usefulProject(project) {
  const name = String(project || '').trim();
  return /^(?:scratch-\d{4}-\d{2}-\d{2}-[a-f\d]+|[a-z]+-[a-z]+-[a-f\d]{6,})$/i.test(name) ? '' : name;
}
