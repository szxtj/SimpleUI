const BASE_URL = 'http://127.0.0.1:31235/api/wiki/rag-context';

const TEST_QUESTIONS = [
  { id: 1, query: '小米集团有多少人', expectedFact: '43,688' },
  { id: 2, query: '莫扎特出生在哪个城市', expectedFact: '萨尔茨堡' },
  { id: 3, query: '珠穆朗玛峰有多高', expectedFact: '8848' },
  { id: 4, query: '长江全长多少千米', expectedFact: '6300' },
  { id: 5, query: '第二次世界大战何时结束', expectedFact: '1945' },
  { id: 6, query: '牛顿第一定律是什么', expectedFact: '惯性' },
  { id: 7, query: '苹果公司的现任CEO是谁', expectedFact: '库克' },
  { id: 8, query: '高血压的主要并发症有哪些', expectedFact: '脑' },
  { id: 9, query: '台積電現任董事長是誰', expectedFact: '魏哲家' },
  { id: 10, query: '特斯拉的主要产品有哪些', expectedFact: 'Model' },
  { id: 11, query: '北京故宫始建于哪一年', expectedFact: '1406' },
  { id: 12, query: '阿根廷国家足球队得过几次世界杯冠军', expectedFact: '3' },
];

async function inspectAll() {
  console.log('========================================================================');
  console.log('🔍 Deep Inspection of 2B-Planned Keywords & Extracted Context Quality');
  console.log('========================================================================\n');

  for (const item of TEST_QUESTIONS) {
    const t0 = Date.now();
    try {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: item.query }),
      });
      const duration = Date.now() - t0;
      if (!res.ok) {
        console.log(`❌ #${item.id} "${item.query}" -> HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const plan = data.metadata?.plan || {};
      const titles = (data.citations || []).map((c) => c.title).join(', ');
      const ctx = data.promptContext || '';

      const containsExpected = item.expectedFact ? ctx.includes(item.expectedFact) : true;
      const statusIcon = containsExpected ? '✅' : '⚠️';

      console.log(`------------------------------------------------------------------------`);
      console.log(`${statusIcon} #${item.id} 用户提问: "${item.query}" (${duration}ms)`);
      console.log(`   🎯 2B小模型规划条目: ${JSON.stringify(plan.target_articles || [])}`);
      console.log(`   🏷️  2B小模型生成关键词: ${JSON.stringify(plan.intent_tokens || [])}`);
      console.log(`   📚 知识库命中条目: [${titles}]`);
      console.log(`   📝 提取总字数: ${ctx.length} 字符 | 关键事实包含("${item.expectedFact}"): ${containsExpected ? 'YES' : 'NO'}`);
      
      // Print first 400 chars of extracted context
      const lines = ctx.split('\n').filter(l => l.trim().length > 0).slice(0, 10);
      console.log(`   📄 提取内容节选:`);
      lines.forEach(l => console.log(`      ${l.slice(0, 90)}`));
    } catch (e) {
      console.error(`💥 #${item.id} "${item.query}" error:`, e.message);
    }
  }

  console.log('\n========================================================================');
  console.log('Inspection complete.');
  console.log('========================================================================\n');
}

inspectAll();
