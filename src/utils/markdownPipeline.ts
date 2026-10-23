/**
 * Markdown & LaTeX 渲染预处理管道 (Markdown Preprocess Pipeline)
 *
 * 核心设计目标：
 * 治理大语言模型（LLM）输出与标准 CommonMark / remark-math 规范之间的格式阻抗匹配：
 * 1. 保护代码块与行内代码：确保代码内的符号绝不被后续流程篡改；
 * 2. 货币符号智能转义：避免 $50、$100 等价格符号被 remark-math 误判为行内公式；
 * 3. LaTeX 定界符规范化：
 *    - 将 \[ ... \] 转换为严格独立行的 $$ ... $$ 围栏（解决 remark-math fence meta 吞噬缺陷）；
 *    - 将多行原生 $$ ... $$ 规整为独立行；
 *    - 将裸写 LaTeX 常见环境（\begin{matrix|aligned|...}）自动补全 $$ 围栏；
 *    - 将 \( ... \) 转换为 $ ... $；
 * 4. 粗体空格清理：修复 ** 粗体 ** 内侧空格导致的 CommonMark 强调解析失效；
 * 5. 精确还原保护块，输出干净合法的 Markdown 文本。
 */

const LATEX_ENV_NAMES = [
  'aligned',
  'align',
  'align\\*',
  'gather',
  'gather\\*',
  'gathered',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'cases',
  'equation',
  'equation\\*',
].join('|');

const STANDALONE_LATEX_ENV_REGEX = new RegExp(
  `(^[ \\t]*(?:>[ \\t]*)*[ \\t]*)(\\\\begin\\{(${LATEX_ENV_NAMES})\\}[\\s\\S]*?\\\\end\\{\\3\\})[ \\t]*(?=\\n|$)`,
  'gm'
);

/**
 * 智能转义货币美元符号（如 $50, $19.99, $1,000, 范围 $5-$10），
 * 同时安全保留合法的行内数学公式（如 $0$, $x = 1$, $1+1=2$）和块级公式（$$）。
 */
export function escapeCurrencyDollars(text: string): string {
  let out = '';
  let index = 0;

  function runLength(t: string, start: number, char: string): number {
    let len = 0;
    while (t[start + len] === char) len++;
    return len;
  }

  function findClosingDollar(t: string, openIdx: number): number {
    let i = openIdx + 1;
    while (i < t.length) {
      const c = t[i];
      if (c === '$') return i;
      if (c === '\\') i += 2;
      else if (c === '\n' && t[i + 1] === '\n') return -1; // 跨段落不作为行内公式搜索范围
      else i++;
    }
    return -1;
  }

  function isMathBody(body: string): boolean {
    if (body.length === 0) return false;
    if (/\n[ \t]*\n/.test(body)) return false;
    // 空格结尾（如 "$5 and $10" 中匹配到 "5 and "）说明是散文，非公式
    if (/\s$/.test(body)) return false;
    // 悬挂操作符结尾（如 "$5-$10" 中匹配到 "5-"）说明是价格区间，非公式
    if (/[-+*/=<>,;:([\u2013\u2014\u2212]$/.test(body)) return false;
    // 包含 LaTeX 反斜杠命令或公式控制符（_ ^ { }）说明是公式
    if (/\\[a-zA-Z]|[_^{}]/.test(body)) return true;
    // 包含两个及以上相邻自然语言单词（如 "price and fee"）说明是散文
    if (/[A-Za-z\u4e00-\u9fa5]{2,}\s+[A-Za-z\u4e00-\u9fa5]{2,}/.test(body)) return false;
    return true;
  }

  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (char !== '$') {
      out += char;
      index++;
      continue;
    }

    // 遇到 $$（块级公式），原样放行
    const dollars = runLength(text, index, '$');
    if (dollars >= 2) {
      out += '$'.repeat(dollars);
      index += dollars;
      continue;
    }

    // 单个 $：检查紧随字符是否为数字（货币特征）
    const nextChar = text[index + 1] ?? '';
    const isDigit = /\d/.test(nextChar);

    if (!isDigit) {
      // 非数字开头（如 $x$），保持为公式定界符
      out += '$';
      index++;
      continue;
    }

    // 以数字开头（如 $50, $100）
    const close = findClosingDollar(text, index);
    if (close !== -1) {
      const body = text.slice(index + 1, close);
      if (isMathBody(body)) {
        // 合法公式（如 $0$, $1+1=2$），保持公式标记
        out += '$';
        index++;
        continue;
      }
    }

    // 判定为货币金额，进行安全转义（\$）
    out += '\\$';
    index++;
  }

  return out;
}

/**
 * 判断块级公式的缩进是否位于列表项内部：
 * 若是，返回该列表项的内容列（例如 "2.  " 返回 4），否则返回 null。
 *
 * 背景：公式若被提升到顶格，会切断所在列表项；而模型紧随其后、
 * 仍按 4 空格缩进的正文会被 CommonMark 解析成“缩进代码块”。
 */
function enclosingListContentIndent(textBefore: string, indent: string): number | null {
  if (!indent) return null;
  const lines = textBefore.split('\n');
  // 当前行只剩行首缩进（已被正则消耗），去掉这个空片段
  if (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const marker = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])([ \t]+)/.exec(line);
    if (marker) {
      // 公式缩进比列表标记还浅，说明它已经不在该列表项内部
      return marker[1].length < indent.length ? marker[0].length : null;
    }
    const lineIndent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (lineIndent < indent.length) return null;
  }
  return null;
}

/**
 * 按给定缩进整体缩进多行公式内容（空行保持为空行）；
 * 已带相同缩进的行原样保留，保证重复预处理时不会越缩越深。
 */
function indentBlockContent(content: string, indent: string): string {
  const trimmed = content.trim();
  if (!indent) return trimmed;
  return trimmed
    .split('\n')
    .map((line) => (!line.trim() ? '' : line.startsWith(indent) ? line : indent + line))
    .join('\n');
}

/**
 * 判断块级公式前是否已有空行或空引用行（如 ">"、"> >"），避免在引用块内重复注入空引用行导致块结构碎裂。
 */
function isPrecededByBlankOrQuoteLine(textBefore: string): boolean {
  const lines = textBefore.split('\n');
  if (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) return true;
  const lastLine = lines[lines.length - 1].trim();
  return lastLine === '' || /^>+$/.test(lastLine.replace(/[ \t]/g, ''));
}

/**
 * 解析行首前缀，分离 Markdown 引用符（如 "> "、"> > "）与后续缩进空格。
 */
function parseLinePrefix(prefix: string): { quotePrefix: string; indent: string } {
  if (!prefix) return { quotePrefix: '', indent: '' };
  const quoteMatch = prefix.match(/^([ \t]*(?:>[ \t]?)+)/);
  const quotePrefix = quoteMatch ? quoteMatch[1] : '';
  const indent = prefix.slice(quotePrefix.length);
  return { quotePrefix, indent };
}

/**
 * 清除多行公式每行行首的 Markdown 引用符（如 "> "），防止 KaTeX 将 ">" 当成数学符号（大于号）渲染进公式。
 * 精确匹配对应层级的引用前缀，避免公式内部换行书写的数学比较符（如 "> 0"、"> b"）被误删。
 */
function cleanQuotePrefixFromLines(content: string, quotePrefix: string): string {
  if (!quotePrefix) return content;
  const trimmedPrefix = quotePrefix.trimEnd();
  return content
    .split('\n')
    .map((line) => {
      if (line.startsWith(quotePrefix)) {
        return line.slice(quotePrefix.length);
      }
      if (line.trim() === trimmedPrefix) {
        return '';
      }
      return line;
    })
    .join('\n');
}

/**
 * 为引用块内的多行公式每行统一添加引用前缀（空行按 Markdown 规范保留引用竖线）。
 */
function prefixQuoteLines(content: string, prefix: string): string {
  const trimmed = content.trim();
  if (!prefix) return trimmed;
  return trimmed
    .split('\n')
    .map((line) => (!line.trim() ? prefix.trimEnd() : prefix + line))
    .join('\n');
}

/**
 * 把块级公式规整为独立围栏：
 * 1. 引用块（Blockquote）内的公式保留在引用块内部，剔除内部行首的 ">" 避免公式两侧残留大于号，并保持引用竖线连贯；
 * 2. 列表项内的公式保留在列表项内部，维持缩进列；
 * 3. 其余情况提升到顶格独立围栏。
 */
function formatBlockMath(
  content: string,
  textBefore: string,
  rawPrefix: string,
  matchLength = 0,
  whole = ''
): string {
  const lastNl = textBefore.lastIndexOf('\n');
  const currentLine = textBefore.slice(lastNl + 1);
  const effectivePrefix =
    rawPrefix || (currentLine.match(/^([ \t]*(?:>[ \t]?)+)/)?.[1] ?? '');

  const { quotePrefix, indent } = parseLinePrefix(effectivePrefix);
  const cleanedMath = cleanQuotePrefixFromLines(content, quotePrefix);

  if (quotePrefix) {
    const quoteLine = quotePrefix.trimEnd();
    const linePrefix = quotePrefix + (indent || '');
    const body = prefixQuoteLines(cleanedMath, linePrefix);

    const needLeadingNewline = textBefore.length > 0 && !textBefore.endsWith('\n');
    const preNl = needLeadingNewline ? '\n' : '';

    const needLeadingBlank = !isPrecededByBlankOrQuoteLine(textBefore);
    const lead = needLeadingBlank ? `${quoteLine}\n` : '';

    let trail = '';
    if (matchLength > 0 && whole) {
      const charAfter = whole[textBefore.length + matchLength];
      if (charAfter !== undefined && charAfter !== '\n' && charAfter !== '\r') {
        trail = `\n${linePrefix}`;
      }
    }

    return `${preNl}${lead}${linePrefix}$$\n${body}\n${linePrefix}$$${trail}`;
  }

  const listContentIndent = enclosingListContentIndent(textBefore, indent);
  const keep = listContentIndent === null ? '' : ' '.repeat(listContentIndent);
  return `\n\n${keep}$$\n${indentBlockContent(cleanedMath, keep)}\n${keep}$$\n\n`;
}

/**
 * 标准化 LaTeX 公式定界符与环境：
 * 1. 多行原生 $$ ... $$ 围栏换行规整（支持引用块与列表项保留前缀）
 * 2. 块级公式 \[ ... \] 转换为标准的 $$ ... $$（支持引用块与列表项保留前缀）
 * 3. 行内公式 \( ... \) 转换为 $...$
 * 4. 保护已有合法定界符包裹的公式块（$$ ... $$ 与 $ ... $）
 * 5. 裸写 LaTeX 常见矩阵/方程环境自动补全 $$ 围栏
 * 6. 还原保护的已有公式块
 */
export function normalizeMathDelimiters(text: string): string {
  // 1. 多行原生 $$ ... $$ 围栏换行规整（支持引用块与列表项保留前缀）
  let normalized = text.replace(
    /(^[ \t]*(?:>[ \t]*)*[ \t]*)?\$\$([\s\S]*?)\$\$/gm,
    (match, prefix: string | undefined, math: string, offset: number, whole: string) => {
      if (!math.includes('\n')) return match;
      return formatBlockMath(math, whole.slice(0, offset), prefix ?? '', match.length, whole);
    }
  );

  // 2. 块级公式 \[ ... \] 转换为标准的 $$ ... $$（支持引用块与列表项保留前缀）
  normalized = normalized.replace(
    /(^[ \t]*(?:>[ \t]*)*[ \t]*)?\\\[([\s\S]*?)\\\]/gm,
    (match, prefix: string | undefined, math: string, offset: number, whole: string) =>
      formatBlockMath(math, whole.slice(0, offset), prefix ?? '', match.length, whole)
  );

  // 3. 行内公式 \( ... \) 转换为 $...$
  normalized = normalized.replace(
    /\\\(([\s\S]*?)\\\)/g,
    (_, math) => {
      const trimmed = math.trim();
      return trimmed ? `$${trimmed}$` : '';
    }
  );

  // 4. 保护已有合法定界符包裹的公式块（$$ ... $$ 与 $ ... $）
  // 核心防御：避免已有公式内部跨行书写的 \begin{cases}、\begin{aligned}、\begin{matrix} 等被错误当成“裸写环境”再次包裹 $$ 而撕裂公式
  const protectedMathBlocks: string[] = [];
  normalized = normalized.replace(
    /(\$\$[\s\S]*?\$\$|\$[^\$\n]+\$)/g,
    (match) => {
      protectedMathBlocks.push(match);
      return `__STANDALONE_PROTECTED_MATH_${protectedMathBlocks.length - 1}__`;
    }
  );

  // 5. 裸写 LaTeX 环境（未被任何 $$ 或 $ 包裹的孤立顶级环境，自动补全 $$ 围栏）
  normalized = normalized.replace(
    STANDALONE_LATEX_ENV_REGEX,
    (match, prefix: string | undefined, env: string, _envName: string, offset: number, whole: string) =>
      formatBlockMath(env, whole.slice(0, offset), prefix ?? '', match.length, whole)
  );

  // 6. 还原保护的已有公式块
  normalized = normalized.replace(
    /__STANDALONE_PROTECTED_MATH_(\d+)__/g,
    (_, idx) => protectedMathBlocks[parseInt(idx, 10)] ?? ''
  );

  return normalized;
}

/**
 * 修复定界符内侧带空格的粗体（如 ** 粗体 ** -> **粗体**）
 */
export function normalizeBoldSpacing(text: string): string {
  return text.replace(
    /\*\*([ \t]*)([^\*\n]*?)([ \t]*)\*\*/g,
    (match, _lead: string, body: string) => (body.trim() ? `**${body.trim()}**` : match)
  );
}

/**
 * Markdown 全流程预处理主入口
 */
export function preprocessMarkdown(content: string): string {
  if (!content) return '';

  const codeTokens: string[] = [];
  const mathTokens: string[] = [];

  // 阶段 1：保护代码块（```...``` 与 `...`）
  let protectedContent = content.replace(
    /(```[\s\S]*?```|`[^`\n]+`)/g,
    (match) => {
      codeTokens.push(match);
      return `__MD_PROTECTED_CODE_${codeTokens.length - 1}__`;
    }
  );

  // 阶段 2：货币符号智能转义
  let transformed = escapeCurrencyDollars(protectedContent);

  // 阶段 3：LaTeX 定界符与环境标准化
  transformed = normalizeMathDelimiters(transformed);

  // 阶段 4：在执行粗体修剪前保护公式块（避免公式中的乘号 * 被误判为强调）
  transformed = transformed.replace(
    /(\$\$[\s\S]*?\$\$|\$[^\$\n]+\$)/g,
    (match) => {
      mathTokens.push(match);
      return `__MD_PROTECTED_MATH_${mathTokens.length - 1}__`;
    }
  );

  // 阶段 5：粗体空格清理
  transformed = normalizeBoldSpacing(transformed);

  // 阶段 6：还原公式块
  transformed = transformed.replace(
    /__MD_PROTECTED_MATH_(\d+)__/g,
    (_, idx) => mathTokens[parseInt(idx, 10)] ?? ''
  );

  // 阶段 7：还原代码块
  transformed = transformed.replace(
    /__MD_PROTECTED_CODE_(\d+)__/g,
    (_, idx) => codeTokens[parseInt(idx, 10)] ?? ''
  );

  return transformed;
}
