// P0 核心实体回现校验 回归脚本
// 目标：① 本例幻觉候选被拦截  ② 主实体链路与合法次级实体不被误杀
import { wikiService } from '../server/wiki_service.js';

await wikiService.startService();
console.log('kiwix online =', wikiService.isOnline, '| contentId =', wikiService.contentId, '\n');

const CASES = [
  '哥德巴赫猜想是谁提出的？主要是讲的什么内容？', // 原始问题：次级实体「康托」应被拦截
  '周杰伦的第一张专辑叫什么',                     // 次级实体应为合法关联实体，不应误杀
  '特斯拉现在的CEO是谁',                          // 次级实体「埃隆·马斯克」应保留
  '光速是多少',                                   // 单实体问题：P0 完全不触发
  '李白是哪朝人',                                 // 单实体问题：P0 完全不触发
];

for (const q of CASES) {
  console.log('='.repeat(66));
  console.log('Q:', q);
  const t = Date.now();
  const rag = await wikiService.getRagContext(q);
  console.log(`  耗时 ${Date.now() - t} ms | needsWiki=${rag.needsWiki} | 引用 ${rag.citations.length} 条`);
  console.log('  plan =', JSON.stringify(rag.metadata?.plan?.target_articles ?? null));
  console.log('  guard =', JSON.stringify(rag.metadata?.guard ?? null));
  for (const c of rag.citations) {
    console.log(`   · 《${c.title}》 ${c.summary.slice(0, 60)}…`);
  }
  if (!rag.citations.length) console.log('   （无引用）');
  console.log();
}
process.exit(0);
