import React from 'react';

/**
 * 把 assembleArticleContext 产出的行式文本渲染为原生 React 版式：
 *   [小节名]            → 标题
 *   k: v | k: v         → 基本档案键值行
 *   · 条目              → 列表项
 *   | 单元格 | 单元格 |  → 表格
 *   其他行              → 段落
 * 主题跟随 APP（Tailwind dark: 类），不再依赖任何 iframe/皮肤 CSS。
 */

interface ParsedBlock {
  kind: 'heading' | 'kv' | 'list' | 'table' | 'para';
  heading?: string;
  lines: string[];
}

export function parseWikiContext(text: string): ParsedBlock[] {
  const lines = text.split('\n');
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;

  const flush = () => {
    if (current && current.lines.length > 0) blocks.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heading = line.match(/^\[(.+)\]$/);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', heading: heading[1], lines: [] });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (line.startsWith('· ')) {
      if (!current || current.kind !== 'list') {
        flush();
        current = { kind: 'list', lines: [] };
      }
      current.lines.push(line.slice(2).trim());
      continue;
    }
    if (line.startsWith('|')) {
      if (!current || current.kind !== 'table') {
        flush();
        current = { kind: 'table', lines: [] };
      }
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length > 0) current.lines.push(cells.join(' ┃ '));
      continue;
    }
    flush();
    blocks.push({ kind: 'para', lines: [line] });
  }
  flush();
  return blocks;
}

export const WikiContextView: React.FC<{ text: string }> = ({ text }) => {
  const blocks = parseWikiContext(text);

  return (
    <div className="px-4 py-3 space-y-3 text-[13px] leading-relaxed select-text">
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          const isInfobox = b.heading === '基本档案';
          return (
            <h3
              key={i}
              className={`pt-1 font-semibold tracking-tight text-emerald-700 dark:text-emerald-400 ${
                isInfobox
                  ? 'text-xs uppercase tracking-wider opacity-80'
                  : 'text-sm border-b border-black/10 dark:border-white/10 pb-1'
              }`}
            >
              {b.heading}
            </h3>
          );
        }
        if (b.kind === 'kv') {
          return (
            <div key={i} className="space-y-1">
              {b.lines.map((l, j) => {
                const ci = l.indexOf(':');
                if (ci === -1)
                  return (
                    <p key={j} className="text-zinc-700 dark:text-zinc-300">
                      {l}
                    </p>
                  );
                return (
                  <p key={j} className="text-zinc-700 dark:text-zinc-300">
                    <span className="font-medium text-[#1f2328] dark:text-[#f1f3f7]">{l.slice(0, ci)}</span>
                    <span className="text-zinc-500 dark:text-zinc-400">{l.slice(ci)}</span>
                  </p>
                );
              })}
            </div>
          );
        }
        if (b.kind === 'list') {
          return (
            <ul key={i} className="space-y-1 pl-1">
              {b.lines.map((l, j) => (
                <li key={j} className="flex gap-2 text-zinc-700 dark:text-zinc-300">
                  <span className="text-emerald-500 flex-shrink-0">·</span>
                  <span>{l}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === 'table') {
          return (
            <div
              key={i}
              className="rounded-lg border border-black/10 dark:border-white/10 overflow-hidden divide-y divide-black/5 dark:divide-white/10"
            >
              {b.lines.map((l, r) => (
                <div
                  key={r}
                  className={`px-2 py-1 text-xs ${r === 0 ? 'bg-black/5 dark:bg-white/10 font-medium' : ''}`}
                >
                  {l}
                </div>
              ))}
            </div>
          );
        }
        return (
          <p key={i} className="text-zinc-700 dark:text-zinc-300">
            {b.lines[0]}
          </p>
        );
      })}
    </div>
  );
};
