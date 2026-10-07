import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import compiled or dynamically evaluate markdownPipeline
const pipelineModulePath = path.resolve(__dirname, '../src/utils/markdownPipeline.ts');
const pipelineContent = fs.readFileSync(pipelineModulePath, 'utf8');

// Use ts-node or simple transpile using dynamic evaluation or esbuild / node
import { preprocessMarkdown, escapeCurrencyDollars, normalizeMathDelimiters, normalizeBoldSpacing } from '../src/utils/markdownPipeline.ts';

console.log("=== Markdown Pipeline Unit Tests ===\n");
let passed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// TC-1: Matrix and multiline block math
test("TC-1: Matrix block math with multiline delimiters", () => {
  const input = `\\[
D_2=\\begin{vmatrix}
a_{11}&a_{12}\\\\
a_{21}&a_{22}
\\end{vmatrix}>0
\\]`;
  const out = preprocessMarkdown(input);
  assert(out.includes("$$\nD_2=\\begin{vmatrix}"));
  assert(out.includes("\\end{vmatrix}>0\n$$"));
});

// TC-2: Currency formatting
test("TC-2: Currency amounts with digits are escaped to \\$", () => {
  const input = `价格从 $50 涨到 $100，特价 $5.99，范围 $10-$20。`;
  const out = preprocessMarkdown(input);
  assert(out.includes("\\$50"));
  assert(out.includes("\\$100"));
  assert(out.includes("\\$5.99"));
  assert(out.includes("\\$10-\\$20"));
});

// TC-3: Standard inline math
test("TC-3: Standard inline math is converted or preserved", () => {
  const input = `已知 \\( x = \\frac{1}{2} \\)，求 \\( y \\)，且 $z = 3$ 与 $0$`;
  const out = preprocessMarkdown(input);
  assert(out.includes("$x = \\frac{1}{2}$"));
  assert(out.includes("$y$"));
  assert(out.includes("$z = 3$"));
  assert(out.includes("$0$"));
});

// TC-4: Standalone LaTeX environment
test("TC-4: Standalone LaTeX environment without brackets is wrapped", () => {
  const input = `
\\begin{bmatrix}
1 & 0 \\\\
0 & 1
\\end{bmatrix}
`;
  const out = preprocessMarkdown(input);
  assert(out.includes("$$\n\\begin{bmatrix}"));
  assert(out.includes("\\end{bmatrix}\n$$"));
});

// TC-5: Code block protection
test("TC-5: Code blocks containing LaTeX or dollar signs remain unchanged", () => {
  const input = `\`\`\`bash
echo "$HOME"
price=\\$100
\\[not_math\\]
\`\`\``;
  const out = preprocessMarkdown(input);
  assert.strictEqual(out, input);
});

// TC-6: Inline code protection
test("TC-6: Inline code containing dollar and brackets remains unchanged", () => {
  const input = `使用命令 \`npm i -g $PACKAGE\` 和 \`arr[0]\``;
  const out = preprocessMarkdown(input);
  assert.strictEqual(out, input);
});

// TC-7: CJK punctuation bold
test("TC-7: CJK punctuation bold is preserved", () => {
  const input = `**注意：**请保留**（重要）**选项`;
  const out = preprocessMarkdown(input);
  assert.strictEqual(out, input);
});

// TC-8: Bold with internal whitespace
test("TC-8: Bold with internal whitespace is trimmed", () => {
  const input = `这是 ** 加粗文本 ** 和 **normal**`;
  const out = preprocessMarkdown(input);
  assert(out.includes("**加粗文本**"));
  assert(out.includes("**normal**"));
});

// TC-9: Mixed complex document
test("TC-9: Mixed complex document does not collapse", () => {
  const input = `# 总结
这里有 $50 现金，公式是 \\[ E=mc^2 \\]，代码是 \`code $1\`。
\\begin{aligned}
a &= b + c
\\end{aligned}
** 加粗 ** 文本。`;
  const out = preprocessMarkdown(input);
  assert(out.includes("\\$50"));
  assert(out.includes("$$\nE=mc^2\n$$"));
  assert(out.includes("`code $1`"));
  assert(out.includes("$$\n\\begin{aligned}"));
  assert(out.includes("**加粗**"));
});

console.log(`\n🎉 All ${passed} unit tests passed successfully!`);
