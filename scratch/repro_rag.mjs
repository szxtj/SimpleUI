// 全链路 RAG 复现脚本：逐环节打点，定位 "未引用知识库" 的断点
import {
  wikiService,
  toSimplifiedChinese,
  getAllVariants,
  judgeNeedsWikiWithLaya,
  planQueryWithSLM,
  rerankCandidatesWithSLM,
  extractFactWithQwen,
} from '../server/wiki_service.js';

const QUERY = process.env.Q || '哥德巴赫猜想是谁提出的？主要是讲的什么内容？';

const log = (...a) => console.log(...a);
const hr = (t) => log('\n' + '='.repeat(70) + `\n[${t}]\n` + '='.repeat(70));

const t0 = Date.now();
const lap = (label, start) => log(`   ⏱  ${label}: ${Date.now() - start} ms`);

hr('STEP A · 启动 Kiwix 知识库服务');
let s = Date.now();
const started = await wikiService.startService();
lap('startService', s);
log('   isOnline      =', wikiService.isOnline);
log('   contentId     =', wikiService.contentId);
log('   currentZimPath=', wikiService.currentZimPath);
if (!started) { log('❌ 知识库离线，链路在 getRagContext 第 0 步熔断'); process.exit(1); }

hr('STEP 0 · 全局归一 toSimplifiedChinese');
s = Date.now();
const normalized = toSimplifiedChinese(QUERY.trim());
lap('normalize', s);
log('   原始提问 :', QUERY);
log('   归一结果 :', normalized);

hr('STEP 1 · LAYA System 1 意图门禁 (port 1236)');
s = Date.now();
const laya = await judgeNeedsWikiWithLaya(normalized);
lap('judgeNeedsWikiWithLaya', s);
log('   返回值 =', JSON.stringify(laya), '(false=放行不检索 / true=进RAG / null=服务不可达)');
if (laya === false) log('   ❌ 门禁判定为 chitchat_or_code → 直接放行，无知识库');

hr('STEP 2 · Qwen 3.5 2B 神经实体规划 (port 1234)');
s = Date.now();
const plan = await planQueryWithSLM(normalized);
lap('planQueryWithSLM', s);
log('   plan =', JSON.stringify(plan));
const targets = plan?.target_articles?.length ? plan.target_articles.slice(0, 2) : [normalized];
log('   targetArticles =', JSON.stringify(targets));

for (const entity of targets) {
  hr(`STEP 3-5 · 检索+重排+摘要  entity="${entity}"`);
  log('   variants =', JSON.stringify(getAllVariants(entity)));

  s = Date.now();
  let matches = await wikiService.search(entity);
  lap('search', s);
  log(`   search 命中 ${matches.length} 条:`);
  matches.slice(0, 8).forEach((m, i) => log(`     ${i + 1}. ${m.title}   (score=${m.score ?? '-'})`));

  if (!matches.length) { log('   ❌ 零命中，本实体无候选'); continue; }

  s = Date.now();
  matches = await rerankCandidatesWithSLM(QUERY.trim(), matches);
  lap('rerank', s);
  log('   重排后 Top3:', JSON.stringify(matches.slice(0, 3).map((m) => m.title)));

  for (const m of matches.slice(0, 3)) {
    log(`\n   ---- 尝试抓取: ${m.title} ----`);
    s = Date.now();
    const sum = await wikiService._fetchSummaryForTitle(m.title, QUERY.trim());
    lap('fetchSummary', s);
    if (sum && sum.summary) {
      log('   ✅ 摘要成功:', sum.title);
      log('   summary:', sum.summary);
    } else {
      log('   ⚠️  _fetchSummaryForTitle 返回空 (MRC 输出 NONE / 抓取失败)');
    }
  }
}

hr('STEP 6 · 端到端 getRagContext(原始提问)');
s = Date.now();
const rag = await wikiService.getRagContext(QUERY);
lap('getRagContext', s);
log(JSON.stringify(rag, null, 2));

hr('结论');
log('needsWiki      =', rag.needsWiki);
log('citations      =', rag.citations?.length ?? 0);
log('promptContext  =', rag.promptContext ? `${rag.promptContext.length} 字` : '(空)');
log('metadata       =', JSON.stringify(rag.metadata));
log(`总耗时 ${Date.now() - t0} ms`);

process.exit(0);
