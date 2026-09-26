// MRC 环节 A/B 对比：Qwen 3.5 2B  vs  主力模型
// 用法：
//   node scratch/ab_mrc.mjs                                              # 走 Qwen 3.5 2B（默认）
//   MRC_API_URL=http://127.0.0.1:1235 MRC_MODEL=gemma-4-26b-a4b-it \
//     node scratch/ab_mrc.mjs                                            # 走主力模型
import {
  wikiService,
  assembleArticleContext,
  extractFactWithQwen,
  MRC_API_URL,
  MRC_MODEL,
} from '../server/wiki_service.js';

await wikiService.startService();
console.log('MRC 后端 =', MRC_API_URL, '| model =', MRC_MODEL, '\n');

// [条目, 提问, 期望: 'fact' 应给出事实 / 'none' 应弃权]
const CASES = [
  ['哥德巴赫猜想', '哥德巴赫猜想是谁提出的？主要是讲的什么内容？', 'fact'],
  ['格奥尔格·康托尔', '哥德巴赫猜想是谁提出的？主要是讲的什么内容？', 'none'],
  ['康托尔集', '哥德巴赫猜想是谁提出的？主要是讲的什么内容？', 'none'],
  ['周杰伦', '周杰伦的第一张专辑叫什么', 'fact'],
  ['沃登克里弗塔', '特斯拉现在的CEO是谁', 'none'],
  ['光速', '光速是多少', 'fact'],
];

let correct = 0;
for (const [title, question, expect] of CASES) {
  const url = `http://127.0.0.1:31236/content/${wikiService.contentId}/${encodeURIComponent(title)}`;
  const html = await (await fetch(url)).text();
  const assembled = await assembleArticleContext(html, question);
  if (!assembled?.context) {
    console.log(`《${title}》 无法组装上下文，跳过`);
    continue;
  }

  const t = Date.now();
  const fact = await extractFactWithQwen(question, title, assembled.context);
  const ms = Date.now() - t;

  const got = fact ? 'fact' : 'none';
  const ok = got === expect;
  if (ok) correct++;
  console.log(`${ok ? '✅' : '❌'} 《${title}》 期望=${expect} 实际=${got}  ${ms}ms`);
  if (fact) console.log(`      ${fact}`);
}

console.log(`\n正确率 ${correct}/${CASES.length}`);
process.exit(0);
