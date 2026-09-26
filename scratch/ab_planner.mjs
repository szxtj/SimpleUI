// 实体规划 A/B：Qwen 3.5 2B  vs  主力模型
// 严格串行，绝不对主力模型并发（TTF 不支持多路并发）
import { planQueryWithSLM, planQueryWithMainModel } from '../server/wiki_service.js';

const QUERIES = [
  '哥德巴赫猜想是谁提出的？主要是讲的什么内容？',
  '周杰伦的第一张专辑叫什么',
  '特斯拉现在的CEO是谁',
  '光速是多少',
  '李白是哪朝人',
  '中国第一颗原子弹爆炸是在什么时候',
  '苹果公司什么时候成立的',
];

console.log('后端 =', process.env.PLANNER_BACKEND || 'slm（默认）', '\n');

for (const q of QUERIES) {
  console.log('问:', q);

  let t = Date.now();
  const slm = await planQueryWithSLM(q);
  const slmMs = Date.now() - t;
  console.log(`   Qwen2B  ${slmMs}ms  ${JSON.stringify(slm?.target_articles ?? null)}`);

  t = Date.now();
  const main = await planQueryWithMainModel(q);
  const mainMs = Date.now() - t;
  console.log(`   主力模型 ${mainMs}ms  ${JSON.stringify(main?.target_articles ?? null)}`);

  console.log();
}
process.exit(0);
