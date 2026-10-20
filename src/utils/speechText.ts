/**
 * 把 Markdown 正文转成适合朗读的纯文本。
 * 代码块整段跳过（读出来只是噪音），公式与链接语法一并清掉。
 */
export function markdownToSpeechText(markdown: string): string {
  let s = String(markdown || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  s = s.replace(/\$[^$\n]*\$/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^>\s?/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ');
  s = s.replace(/\|/g, ' ');
  s = s.replace(/[*_~]{1,3}/g, '');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
