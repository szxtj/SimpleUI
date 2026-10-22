/**
 * 朗读用的文本处理。
 *
 * 核心是 `splitSpeechSegments()`：把 Markdown 正文切成「一段一次交给 TTS」的片段。
 * 旧的「把空白压成一个空格」做法会把段落结构彻底抹平——模型收到一整块长文本后
 * 容易拖长音、串句，也没法分段回报进度（实测 0.6B 在长整块上语速明显失真）。
 *
 * 切分原则（结构优先，不做机械截断）：
 *   1. 代码块 / 公式块整体丢弃（读出来只是噪音）；
 *   2. 按行保留块结构：空行、标题、列表项、引用、表格行各自成块；
 *   3. 长块只在句末标点处切（。！？；!?;… 或拉丁句点），不切断句子；
 *   4. 过短的块向前合并，避免「是的。」这种孤立短句让模型拖长音。
 */

/** 单段软上限：超过就在句末切；实测 100–120 字一段的语速与停顿最自然。 */
export const SPEECH_SEGMENT_MAX_CHARS = 120;

/** 低于这个长度的块尝试与前一段合并（合并后仍不超上限才合）。 */
const SPEECH_SEGMENT_MIN_CHARS = 24;

/** 行内 Markdown → 纯文本（保留标点，块结构交给上层） */
function stripInline(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/<[^>]+>/g, ' ') // 内联 HTML
    .replace(/^\s{0,3}#{1,6}\s+/, '') // 标题
    .replace(/^\s{0,3}>+\s?/, '') // 引用
    .replace(/^\s*[-*+]\s+/, '') // 无序列表
    .replace(/^\s*\d+[.、)]\s+/, '') // 有序列表
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/, ' ') // 表格分隔行
    .replace(/\|/g, ' ') // 表格单元格
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 在句末标点后切开（标点留在前一段末尾） */
function splitSentences(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  // 中文句末标点直接切；拉丁句点要求后面是空白，避免切开 3.14 / U.S.
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

/** 拼接两段时是否需要空格（中英混排不硬塞空格） */
function joinPieces(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const needsSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
  return needsSpace ? `${a} ${b}` : a + b;
}

/**
 * 把 Markdown 切成朗读片段。
 * 返回空数组表示「没有可朗读的内容」（纯代码块 / 空内容）。
 */
export function splitSpeechSegments(markdown: string): string[] {
  const raw = String(markdown || '');
  if (!raw.trim()) return [];

  // 代码块、公式块整段丢弃
  const withoutBlocks = raw
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/\$\$[\s\S]*?\$\$/g, '\n');

  const blocks: string[] = [];
  for (const line of withoutBlocks.split(/\n/)) {
    const text = stripInline(line);
    if (text) blocks.push(text);
  }

  // 长块按句切，再贪心合并到不超过上限
  const chunks: string[] = [];
  for (const block of blocks) {
    if (block.length <= SPEECH_SEGMENT_MAX_CHARS) {
      chunks.push(block);
      continue;
    }
    let buf = '';
    for (const piece of splitSentences(block)) {
      if (!buf) {
        buf = piece;
        continue;
      }
      const merged = joinPieces(buf, piece);
      if (merged.length <= SPEECH_SEGMENT_MAX_CHARS) {
        buf = merged;
      } else {
        chunks.push(buf);
        buf = piece;
      }
    }
    if (buf) chunks.push(buf);
  }

  // 过短的块尽量并进前一段（不超上限时）
  const segments: string[] = [];
  for (const chunk of chunks) {
    const prev = segments[segments.length - 1];
    if (
      prev &&
      (chunk.length < SPEECH_SEGMENT_MIN_CHARS || prev.length < SPEECH_SEGMENT_MIN_CHARS) &&
      joinPieces(prev, chunk).length <= SPEECH_SEGMENT_MAX_CHARS
    ) {
      segments[segments.length - 1] = joinPieces(prev, chunk);
    } else {
      segments.push(chunk);
    }
  }

  return segments;
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
