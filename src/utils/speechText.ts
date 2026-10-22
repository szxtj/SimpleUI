/**
 * 朗读用的文本处理。
 *
 * `splitSpeechSegments()` 把 Markdown 切成「一段一次交给 TTS」的片段。
 *
 * 切分规则（按**视觉块**切，不按行、不跨块合并）：
 *   1. 代码块、公式块（`$$…$$` / `\[…\]` / `\begin{…}`）整段丢弃，一个字都不交给模型；
 *   2. 块边界 = 空行 / 标题 / 列表 / 表格 / 引用；同一段落内的软换行先拼回一行再切；
 *   3. 表格按行读：每行单元格用「，」连接，行序即原顺序；
 *   4. 只在一个块**超过软上限**时才按句末标点切，且只在块内切；
 *   5. emoji 与装饰性符号（ZWJ / 变体选择符 / 肤色 / 区域旗帜）一律剔除；
 *   6. 行内公式、图片、链接语法清掉，只留可朗读的纯文本。
 */

/** 单段软上限：超过就在句末切；实测 100–120 字一段的语速与停顿最自然。 */
export const SPEECH_SEGMENT_MAX_CHARS = 120;

/**
 * emoji 及其组合成分。
 * - `Extended_Pictographic` 覆盖绝大多数表情（含 ZWJ 组合的主体）
 * - `Emoji_Modifier` = 肤色修饰符
 * - 变体选择符 FE0E/FE0F、零宽连接符 200D、键帽 20E3、区域指示符（国旗）
 */
const EMOJI_RE =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

/** CJK 与全角标点：判断两行拼接时是否需要空格 */
const CJK_CHAR = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/** 公式块（跨行）：$$…$$、\[…\]、\begin{…}…\end{…} */
function stripMathBlocks(src: string): string {
  return src
    .replace(/\$\$[\s\S]*?\$\$/g, '\n')
    .replace(/\\\[[\s\S]*?\\\]/g, '\n')
    .replace(/\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\}/g, '\n');
}

/** 行内清洗：链接/图片/行内代码/行内公式/强调标记/HTML/emoji → 纯文本 */
function cleanInline(input: string): string {
  let s = String(input || '');
  s = s.replace(/<img[^>]*>/gi, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // 图片
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 链接保留文字
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1'); // 引用式链接
  s = s.replace(/`([^`]*)`/g, '$1'); // 行内代码
  s = s.replace(/\\\([\s\S]*?\\\)/g, ' '); // \( … \)
  s = s.replace(/\$[^$\n]*\$/g, ' '); // 行内公式 $…$
  s = s.replace(/<[^>]+>/g, ' '); // 内联 HTML
  s = s.replace(/[0-9#*]\u{FE0F}?\u{20E3}/gu, ' '); // 键帽 1️⃣ #️⃣ *️⃣（连同数字一起去掉）
  s = s.replace(EMOJI_RE, ' '); // emoji
  s = s.replace(/[\u200B-\u200F\u2060\uFEFF]/g, ''); // 零宽字符
  // 强调标记（成对才剥，避免吃掉 snake_case / 数学符号）
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/(^|[\s（(])\*([^*\n]+)\*(?=$|[\s，。！？、）),.!?])/g, '$1$2');
  s = s.replace(/(^|[\s（(])_([^_\n]+)_(?=$|[\s，。！？、）),.!?])/g, '$1$2');
  // 公式删除后留下的「： 」这类空格
  s = s.replace(/\s+([，。；：、！？,.;:!?])/g, '$1');
  s = s.replace(/[\u00a0\u3000\s]+/g, ' ');
  // 结尾只剩冒号（多半是公式被删掉的残渣）就去掉；逗号句号是软换行的正常收尾，不能动
  s = s.replace(/[：]+$/, '');
  return s.trim();
}

/** 段内软换行拼回一行：中文之间不加空格，拉丁文之间补空格 */
function joinSoftLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) {
      out = line;
      continue;
    }
    const a = out[out.length - 1];
    const b = line[0];
    out += CJK_CHAR.test(a) && CJK_CHAR.test(b) ? line : ` ${line}`;
  }
  return out;
}

/** 在句末标点后切开（标点留在前一段末尾；拉丁句点要求后面是空白） */
function splitSentences(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[。！？；…]+|[!?;]+(?=\s|$)|\.["')\]]?(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const end = m.index + m[0].length;
    const piece = block.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  }
  const tail = block.slice(start).trim();
  if (tail) out.push(tail);
  return out.length ? out : [block];
}

function joinPieces(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const needsSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
  return needsSpace ? `${a} ${b}` : a + b;
}

/** 超长块按句切，再贪心合并到不超上限（只在块内） */
function splitLong(text: string): string[] {
  const pieces = splitSentences(text);
  const out: string[] = [];
  let buf = '';
  for (const piece of pieces) {
    if (!buf) {
      buf = piece;
      continue;
    }
    const merged = joinPieces(buf, piece);
    if (merged.length <= SPEECH_SEGMENT_MAX_CHARS) buf = merged;
    else {
      out.push(buf);
      buf = piece;
    }
  }
  if (buf) out.push(buf);
  // 单个句子本身超上限（极少）：按字符窗口切开，优先在逗号处断
  return out.flatMap((seg) => {
    if (seg.length <= SPEECH_SEGMENT_MAX_CHARS * 1.5) return [seg];
    const chunks: string[] = [];
    let rest = seg;
    while (rest.length > SPEECH_SEGMENT_MAX_CHARS) {
      let cut = rest.lastIndexOf('，', SPEECH_SEGMENT_MAX_CHARS);
      if (cut < SPEECH_SEGMENT_MAX_CHARS * 0.5) cut = SPEECH_SEGMENT_MAX_CHARS;
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
  });
}

type Block =
  | { kind: 'para'; lines: string[]; sep: 'soft' | 'list' }
  | { kind: 'table'; rows: string[][] };

/**
 * 按行解析出块：空行断段、标题/列表/表格自成块、引用与普通行并入段落。
 * 连续列表项合并成一个块（列表是一个视觉整体，逐条读反而碎）。
 */
function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let table: string[][] | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'para', lines: para, sep: 'soft' });
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ kind: 'para', lines: list, sep: 'list' });
      list = [];
    }
  };
  const flushTable = () => {
    if (table && table.length) blocks.push({ kind: 'table', rows: table });
    table = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushTable();
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) {
      flushAll();
      continue;
    }

    // 表格行：连续的 | … | 归一张表
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|');
      // 分隔行 |---|---| 跳过
      if (cells.every((c) => /^:?-{2,}:?$/.test(c.trim()))) continue;
      if (!table) table = [];
      table.push(cells);
      continue;
    }
    flushTable();

    // 标题
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: 'para', lines: [heading[1]], sep: 'soft' });
      continue;
    }
    // 分隔线
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      flushAll();
      continue;
    }
    // 列表项（连续项合并）
    const item = /^\s*(?:[-*+]|\d+[.)、])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      list.push(item[1]);
      continue;
    }
    // 以项目符号、emoji 或键帽打头的行（模型常这么写），同样当列表项
    if (/^\s*(?:[0-9#*]\u{FE0F}?\u{20E3}|[\u2022\u00b7\u25cf\u25aa\u25a0]|[\p{Extended_Pictographic}])/u.test(line)) {
      flushPara();
      list.push(line.trim());
      continue;
    }
    flushList();
    // 引用
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      para.push(quote[1]);
      continue;
    }
    para.push(line);
  }
  flushAll();
  return blocks;
}

/** 把 Markdown 切成朗读片段。返回空数组表示没有可朗读内容。 */
export function splitSpeechSegments(markdown: string): string[] {
  const raw = String(markdown || '');
  if (!raw.trim()) return [];

  const withoutCode = raw
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n');

  const blocks = parseBlocks(stripMathBlocks(withoutCode));

  const segments: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'table') {
      // 表格：按行读，行内单元格用「，」连起来，行与行之间用句号断开
      let buf = '';
      for (const cells of block.rows) {
        const rowText = cells
          .map((c) => cleanInline(c))
          .filter(Boolean)
          .join('，');
        if (!rowText) continue;
        if (!buf) {
          buf = rowText;
          continue;
        }
        const merged = `${buf.replace(/[。；]$/, '')}。${rowText}`;
        if (merged.length <= SPEECH_SEGMENT_MAX_CHARS) buf = merged;
        else {
          segments.push(buf);
          buf = rowText;
        }
      }
      if (buf) segments.push(buf);
      continue;
    }

    const rawBlock = block.lines.join(' ');
    const hadMath = /\$|\\\(|\\\[/.test(rawBlock);
    const cleaned = block.lines.map((l) => cleanInline(l)).filter(Boolean);
    const text =
      block.sep === 'list'
        ? cleaned.reduce((acc, item) => {
            if (!acc) return item;
            return /[。！？；：]$/.test(acc) ? acc + item : `${acc}。${item}`;
          }, '')
        : joinSoftLines(cleaned);
    if (!text) continue;
    // 以公式为主的块（删掉公式后只剩几个字）不值得读出来
    if (hadMath && text.length < 12) continue;
    if (text.length <= SPEECH_SEGMENT_MAX_CHARS) segments.push(text);
    else segments.push(...splitLong(text));
  }

  return segments.filter((s) => s.length > 0);
}

/**
 * FNV-1a 32bit —— 音频落盘文件名 / 索引校验用。
 * **必须与 server/tts_service.js 的 fnv1a32 逐字节一致**（都按 UTF-8 字节算）。
 */
export function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(String(input));
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
