import React, { useMemo } from 'react';
import katex from 'katex';
import { resolveWikiAsset } from '../utils/wikiFrame';

/**
 * 把条目抽取产出的行式文本渲染为原生 React 版式（只服务面板展示）：
 *   [小节名]              → 标题
 *   私有区标记 sh/3|标题   → 子标题
 *   私有区标记 tex|LaTeX   → KaTeX 行内公式
 *   私有区标记 img|src|注  → 图片 + 图注
 *   私有区标记 tbl|JSON    → 真表格（支持表头与合并单元格）
 *   · 条目                → 列表项
 *   k: v | k: v           → 基本档案键值（仅在「基本档案」标题下）
 *   其他行                → 段落
 *
 * 这些标记由服务端产出，**注入给模型的文本已把它们还原为纯文本**，
 * 因此本组件怎么渲染都不会影响模型看到的上下文。
 * 主题跟随 APP（Tailwind dark: 类），不依赖 iframe / 皮肤 CSS。
 */

const MD_START = '\uE000';
const MD_END = '\uE001';
// 嵌套载荷里的终止符被转义成 U+E002（见服务端 escapeForNesting），解析前先还原
const MD_ESC = '\uE002';
const unescapeNesting = (s: string) => String(s || '').split(MD_ESC).join(MD_END);
const MARKER_RE = new RegExp(MD_START + '([a-z0-9]+)\\|([\\s\\S]*?)' + MD_END, 'g');
const LEADING_SH_RE = new RegExp('^' + MD_START + 'sh\\|([34])\\|([\\s\\S]*?)' + MD_END);
const IMG_LINE_RE = new RegExp('^' + MD_START + 'img\\|([\\s\\S]*?)' + MD_END + '$');
const TBL_LINE_RE = new RegExp('^' + MD_START + 'tbl\\|([\\s\\S]*?)' + MD_END + '$');

/** 单元格：[文本] 或 [文本, colspan, rowspan] */
type Cell = [string] | [string, number, number];
interface TableData {
  h: number;
  r: Cell[][];
}

type ParsedBlock =
  | { kind: 'heading'; heading: string }
  | { kind: 'subheading'; level: number; text: string }
  | { kind: 'list'; lines: string[] }
  | { kind: 'table'; data: TableData | null; lines: string[] }
  | { kind: 'image'; src: string; caption: string }
  | { kind: 'para'; lines: string[] };

/** 行内公式：KaTeX 一次性渲染成 HTML 并缓存（长条目可能上百个公式） */
const Formula: React.FC<{ tex: string }> = React.memo(({ tex }) => {
  const html = useMemo(() => {
    try {
      const out = katex.renderToString(tex, {
        throwOnError: false,
        strict: false,
        output: 'html',
        displayMode: false,
      });
      // KaTeX 遇到不支持的宏（如 MathJax 的 \mbox）不会抛错，而是内联一个 .katex-error 提示；
      // 与其在面板里显示红色报错，不如退回到可读的 LaTeX 原文。
      return out.includes('katex-error') ? null : out;
    } catch {
      return null;
    }
  }, [tex]);

  if (!html) {
    return <code className="rounded bg-black/5 px-1 text-[12px] dark:bg-white/10">{tex}</code>;
  }
  return <span className="wi-tex align-middle" dangerouslySetInnerHTML={{ __html: html }} />;
});
Formula.displayName = 'WikiFormula';

/** 把一段文本按结构化标记切成文本 / 公式片段 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let seq = 0;
  let m: RegExpExecArray | null;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const kind = m[1];
    const payload = m[2];
    if (kind === 'tex') {
      out.push(<Formula key={`${keyPrefix}-f${seq++}`} tex={payload} />);
    } else if (kind === 'img') {
      const i = payload.indexOf('|');
      const caption = i === -1 ? '' : payload.slice(i + 1);
      out.push(caption ? `[图略] ${caption}` : '[图略]');
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function parseWikiContext(text: string): ParsedBlock[] {
  const lines = String(text || '').split('\n');
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;

  const flush = () => {
    if (!current) return;
    const c = current;
    current = null;
    // 空的列表 / 段落 / 无数据的表格块直接丢弃
    if (c.kind === 'table') {
      if (c.data || c.lines.length > 0) blocks.push(c);
      return;
    }
    if (c.kind === 'list' || c.kind === 'para') {
      if (c.lines.length > 0) blocks.push(c);
      return;
    }
    blocks.push(c);
  };

  for (const raw of lines) {
    let line = raw.replace(/\s+$/, '');

    // 1) 行首的子标题标记（可连续多个）
    let sh = LEADING_SH_RE.exec(line);
    while (sh) {
      flush();
      blocks.push({ kind: 'subheading', level: Number(sh[1]), text: unescapeNesting(sh[2]) });
      line = line.slice(sh[0].length);
      sh = LEADING_SH_RE.exec(line);
    }
    if (!line.trim()) continue;

    // 2) 独立成行的图片 / 表格标记
    const img = IMG_LINE_RE.exec(line);
    if (img) {
      flush();
      const i = img[1].indexOf('|');
      blocks.push({ kind: 'image', src: i === -1 ? img[1] : img[1].slice(0, i), caption: i === -1 ? '' : img[1].slice(i + 1) });
      continue;
    }
    const tbl = TBL_LINE_RE.exec(line);
    if (tbl) {
      flush();
      let data: TableData | null = null;
      try {
        const parsed = JSON.parse(tbl[1]);
        if (parsed && Array.isArray(parsed.r)) data = { h: Number(parsed.h) || 0, r: parsed.r };
      } catch {
        data = null;
      }
      blocks.push({ kind: 'table', data, lines: [] });
      continue;
    }

    // 3) 小节标题
    const heading = line.match(/^\[(.+)\]$/);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', heading: heading[1] });
      continue;
    }

    // 4) 列表
    if (line.startsWith('· ') || line === '·') {
      if (!current || current.kind !== 'list') {
        flush();
        current = { kind: 'list', lines: [] };
      }
      current.lines.push(line.slice(2).trim());
      continue;
    }

    // 5) 兼容旧的管道表文本（历史数据 / 非标记来源）
    if (line.startsWith('|')) {
      if (!current || current.kind !== 'table') {
        flush();
        current = { kind: 'table', data: null, lines: [] };
      }
      current.lines.push(line);
      continue;
    }

    // 6) 段落
    if (!current || current.kind !== 'para') {
      flush();
      current = { kind: 'para', lines: [] };
    }
    current.lines.push(line);
  }
  flush();
  return blocks;
}

const TableView: React.FC<{ data: TableData }> = ({ data }) => (
  <div className="-mx-1 overflow-x-auto px-1">
    <table className="w-full border-collapse text-xs">
      <tbody>
        {data.r.map((row, ri) => (
          <tr key={ri} className={ri < data.h ? 'bg-black/5 dark:bg-white/10' : ''}>
            {row.map((cell, ci) => {
              const text = String(cell[0] == null ? '' : cell[0]);
              const cs = cell.length > 1 ? Number(cell[1]) || 1 : 1;
              const rs = cell.length > 2 ? Number(cell[2]) || 1 : 1;
              const cls = `border border-black/10 px-2 py-1 align-top text-left dark:border-white/15 ${
                ri < data.h ? 'font-medium text-[#1f2328] dark:text-[#f1f3f7]' : 'text-zinc-700 dark:text-zinc-300'
              }`;
              const cellText = unescapeNesting(text);
              return ri < data.h ? (
                <th key={ci} colSpan={cs} rowSpan={rs} className={cls}>
                  {renderInline(cellText, `th${ri}-${ci}`)}
                </th>
              ) : (
                <td key={ci} colSpan={cs} rowSpan={rs} className={cls}>
                  {renderInline(cellText, `td${ri}-${ci}`)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const LegacyTableView: React.FC<{ lines: string[] }> = ({ lines }) => (
  <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
    {lines.map((l, r) => (
      <div
        key={r}
        className={`px-2 py-1 text-xs ${r === 0 ? 'bg-black/5 font-medium dark:bg-white/10' : ''}`}
      >
        {renderInline(l, `lt${r}`)}
      </div>
    ))}
  </div>
);

/** 基本档案：`k: v | k: v` → 键值行（仅在「基本档案」标题下启用） */
const InfoboxView: React.FC<{ line: string }> = ({ line }) => {
  const pairs = line
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <div className="space-y-1">
      {pairs.map((p, i) => {
        const ci = p.indexOf(':');
        if (ci === -1) {
          return (
            <p key={i} className="text-zinc-700 dark:text-zinc-300">
              {renderInline(p, `ib${i}`)}
            </p>
          );
        }
        return (
          <p key={i} className="text-zinc-700 dark:text-zinc-300">
            <span className="font-medium text-[#1f2328] dark:text-[#f1f3f7]">{p.slice(0, ci)}</span>
            <span className="text-zinc-500 dark:text-zinc-400">{p.slice(ci)}</span>
          </p>
        );
      })}
    </div>
  );
};

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
              {renderInline(b.heading, `h${i}`)}
            </h3>
          );
        }
        if (b.kind === 'subheading') {
          return (
            <h4
              key={i}
              className={`font-medium text-[#1f2328] dark:text-[#f1f3f7] ${
                b.level >= 4 ? 'text-[12.5px]' : 'text-[13px]'
              } ${b.level >= 4 ? 'opacity-80' : ''}`}
            >
              {renderInline(b.text, `sh${i}`)}
            </h4>
          );
        }
        if (b.kind === 'list') {
          return (
            <ul key={i} className="space-y-1 pl-1">
              {b.lines.map((l, j) => (
                <li key={j} className="flex gap-2 text-zinc-700 dark:text-zinc-300">
                  <span className="flex-shrink-0 text-emerald-500">·</span>
                  <span>{renderInline(l, `li${i}-${j}`)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === 'image') {
          const url = resolveWikiAsset(b.src);
          const caption = unescapeNesting(b.caption);
          return (
            <figure key={i} className="space-y-1.5">
              {url && (
                <img
                  src={url}
                  alt={caption}
                  loading="lazy"
                  className="h-auto w-full rounded-lg border border-black/10 dark:border-white/10"
                />
              )}
              {caption && (
                <figcaption className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {renderInline(caption, `cap${i}`)}
                </figcaption>
              )}
            </figure>
          );
        }
        if (b.kind === 'table') {
          if (b.data) return <TableView key={i} data={b.data} />;
          if (b.lines.length) return <LegacyTableView key={i} lines={b.lines} />;
          return null;
        }
        // para：紧跟「基本档案」标题时按键值行渲染
        const prev = blocks[i - 1];
        const isInfoboxLine = prev && prev.kind === 'heading' && prev.heading === '基本档案';
        if (isInfoboxLine && b.lines.length === 1 && b.lines[0].includes(' | ')) {
          return <InfoboxView key={i} line={b.lines[0]} />;
        }
        return (
          <p key={i} className="text-zinc-700 dark:text-zinc-300">
            {b.lines.map((l, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(l, `p${i}-${j}`)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
};
