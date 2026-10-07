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
  `(?:^|\\n)[ \\t]*(\\\\begin\\{(${LATEX_ENV_NAMES})\\}[\\s\\S]*?\\\\end\\{\\2\\})[ \\t]*(?=\\n|$)`,
  'g'
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
 * 标准化 LaTeX 公式定界符与环境：
 * 1. 块级公式 \[ ... \] 转换为独立的 \n\n$$\n...$$\n\n
 * 2. 裸写 LaTeX 常见矩阵/方程环境自动补全 $$ 围栏
 * 3. 紧贴的多行 $$...$$ 规整为换行围栏
 * 4. 行内公式 \( ... \) 转换为 $...$
 */
export function normalizeMathDelimiters(text: string): string {
  // 1. 块级公式 \[ ... \]
  let normalized = text.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_, math) => `\n\n$$\n${math.trim()}\n$$\n\n`
  );

  // 2. 裸写 LaTeX 环境（未被 $$ 或 \[ 包裹的顶层环境）
  normalized = normalized.replace(
    STANDALONE_LATEX_ENV_REGEX,
    (_, env) => `\n\n$$\n${env.trim()}\n$$\n\n`
  );

  // 3. 多行原生 $$ ... $$ 围栏换行规整
  normalized = normalized.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (match, math) => {
      if (math.includes('\n')) {
        return `\n\n$$\n${math.trim()}\n$$\n\n`;
      }
      return match;
    }
  );

  // 4. 行内公式 \( ... \)
  normalized = normalized.replace(
    /\\\(([\s\S]*?)\\\)/g,
    (_, math) => {
      const trimmed = math.trim();
      return trimmed ? `$${trimmed}$` : '';
    }
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
