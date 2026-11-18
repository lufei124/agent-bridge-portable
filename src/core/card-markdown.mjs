// Feishu Markdown image destinations must be keys returned by its upload API.
// Agent replies contain filesystem paths or URLs, so show those as file references.
export function cardMarkdown(text) {
  return String(text).replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[ \t]*(?=\r?\n|$)|$)|(`+)[^\n]*?\2|!\[([^\]\r\n]*)\]\(([^\r\n()]*(?:\([^\r\n()]*\)[^\r\n()]*)*)\)|!\[/g,
    (match, fence, inline, alt, target) => {
      if (fence || inline) return match;
      if (target === undefined) return '&#33;[';
      const label = alt.trim() || '图片';
      const reference = `${label}（${target.trim()}）`;
      // An inline code span keeps paths, spaces, and Markdown delimiters literal.
      const longestRun = Math.max(0, ...(reference.match(/`+/g) || []).map((run) => run.length));
      const delimiter = '`'.repeat(longestRun + 1);
      return `📷 ${delimiter} ${reference} ${delimiter}`;
    },
  );
}
