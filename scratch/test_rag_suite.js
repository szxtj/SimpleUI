const BASE_URL = 'http://127.0.0.1:31235/api/wiki/rag-context';

const TEST_CASES = [
  // 1. Factoid & Attribute Queries (Expected: needsWiki = true, citations > 0)
  { id: 1, type: 'factoid', query: '介绍一下小米集团', expectedNeedsWiki: true, expectedTitleIncludes: ['小米集团'] },
  { id: 2, type: 'attribute', query: '小米集团有多少人', expectedNeedsWiki: true, expectedTitleIncludes: ['小米集团'] },
  { id: 3, type: 'attribute', query: '雷军创办了哪些公司', expectedNeedsWiki: true, expectedTitleIncludes: ['雷军'] },
  { id: 4, type: 'factoid', query: '什么是量子纠缠', expectedNeedsWiki: true, expectedTitleIncludes: ['量子纠缠'] },
  { id: 5, type: 'factoid', query: '莫扎特出生在哪个城市', expectedNeedsWiki: true, expectedTitleIncludes: ['沃尔夫冈·阿马德乌斯·莫扎特', '莫扎特'] },
  { id: 6, type: 'factoid', query: '牛顿第一定律是什么', expectedNeedsWiki: true, expectedTitleIncludes: ['牛顿第一定律', '牛顿运动定律'] },
  { id: 7, type: 'factoid', query: '珠穆朗玛峰有多高', expectedNeedsWiki: true, expectedTitleIncludes: ['珠穆朗玛峰'] },
  { id: 8, type: 'factoid', query: '苹果公司的现任CEO是谁', expectedNeedsWiki: true, expectedTitleIncludes: ['苹果公司'] },
  { id: 9, type: 'factoid', query: '特斯拉的主要产品有哪些', expectedNeedsWiki: true, expectedTitleIncludes: ['特斯拉'] },
  { id: 10, type: 'factoid', query: '明朝的开国皇帝是谁', expectedNeedsWiki: true, expectedTitleIncludes: ['朱元璋', '明朝'] },

  // 2. Traditional Chinese Queries (Expected: needsWiki = true)
  { id: 11, type: 'traditional', query: '台積電現任董事長是誰', expectedNeedsWiki: true, expectedTitleIncludes: ['台積電', '台积电'] },
  { id: 12, type: 'traditional', query: '介紹一下香港科技大學', expectedNeedsWiki: true, expectedTitleIncludes: ['香港科技大學', '香港科技大学'] },
  { id: 13, type: 'traditional', query: '孫中山建立了什麼政黨', expectedNeedsWiki: true, expectedTitleIncludes: ['孫中山', '中国国民党'] },

  // 3. Multi-Entity Comparison (Expected: needsWiki = true, citations >= 2)
  { id: 14, type: 'comparison', query: '对比一下腾讯和阿里的创立时间', expectedNeedsWiki: true, minCitations: 2 },
  { id: 15, type: 'comparison', query: '苹果和微软哪个成立更早', expectedNeedsWiki: true, minCitations: 2 },

  // 4. Chit-chat / Casual Greetings (Expected: needsWiki = false, citations == 0)
  { id: 16, type: 'chit-chat', query: '你好啊', expectedNeedsWiki: false },
  { id: 17, type: 'chit-chat', query: '早上好，吃过早饭了吗', expectedNeedsWiki: false },
  { id: 18, type: 'chit-chat', query: '给我讲个笑话吧', expectedNeedsWiki: false },
  { id: 19, type: 'chit-chat', query: '今天天气怎么样', expectedNeedsWiki: false },
  { id: 20, type: 'chit-chat', query: '谢谢你，你真棒', expectedNeedsWiki: false },

  // 5. Code & Math (Expected: needsWiki = false, citations == 0)
  { id: 21, type: 'coding', query: '用Python写一个快速排序算法', expectedNeedsWiki: false },
  { id: 22, type: 'coding', query: '怎么在React中使用useEffect', expectedNeedsWiki: false },
  { id: 23, type: 'coding', query: '写一个Java读取文件内容的函数', expectedNeedsWiki: false },
  { id: 24, type: 'math', query: '计算 123 * 456 等于多少', expectedNeedsWiki: false },
  { id: 25, type: 'translation', query: '把这句话翻译成英文：海内存知己，天涯若比邻', expectedNeedsWiki: false },

  // 6. Science / Technology Factoids
  { id: 26, type: 'science', query: '光速是多少米每秒', expectedNeedsWiki: true, expectedTitleIncludes: ['光速'] },
  { id: 27, type: 'science', query: '人类登月是哪一年', expectedNeedsWiki: true, expectedTitleIncludes: ['阿波罗11号', '阿波罗计划', '登月', '阿提米絲'] },
  { id: 28, type: 'history', query: '第二次世界大战何时结束', expectedNeedsWiki: true, expectedTitleIncludes: ['第二次世界大战'] },
  { id: 29, type: 'geography', query: '长江全长多少千米', expectedNeedsWiki: true, expectedTitleIncludes: ['长江'] },
  { id: 30, type: 'factoid', query: '故宫始建于哪一年', expectedNeedsWiki: true, expectedTitleIncludes: ['北京故宫', '故宫'] },
];

async function runSuite() {
  console.log(`\n===============================================================`);
  console.log(`🧪 Running SimpleUI RAG 30-Question Verification Suite`);
  console.log(`===============================================================\n`);

  let passed = 0;
  let total = TEST_CASES.length;
  let totalLatency = 0;
  let warmLatencies = [];

  for (const tc of TEST_CASES) {
    const t0 = Date.now();
    try {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: tc.query }),
      });
      const duration = Date.now() - t0;
      totalLatency += duration;
      warmLatencies.push(duration);

      if (!res.ok) {
        console.log(`❌ [FAIL] #${tc.id} (${tc.type}): "${tc.query}" -> HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      let ok = true;
      let reason = '';

      // Check needsWiki boolean match
      if (data.needsWiki !== tc.expectedNeedsWiki) {
        ok = false;
        reason = `expected needsWiki=${tc.expectedNeedsWiki}, got ${data.needsWiki}`;
      }

      // Check min citations
      if (ok && tc.minCitations && data.citations.length < tc.minCitations) {
        ok = false;
        reason = `expected at least ${tc.minCitations} citations, got ${data.citations.length}`;
      }

      // Check expected title match
      if (ok && tc.expectedTitleIncludes && tc.expectedTitleIncludes.length > 0) {
        const foundTitles = data.citations.map((c) => c.title);
        const match = tc.expectedTitleIncludes.some((expected) =>
          foundTitles.some((t) => t.includes(expected) || expected.includes(t))
        );
        if (!match) {
          ok = false;
          reason = `citations [${foundTitles.join(', ')}] did not match any of [${tc.expectedTitleIncludes.join(', ')}]`;
        }
      }

      // Check prompt context sanity if needsWiki=true
      if (ok && tc.expectedNeedsWiki) {
        if (!data.promptContext || data.promptContext.length < 50) {
          ok = false;
          reason = `promptContext too short or empty (${data.promptContext?.length || 0} chars)`;
        }
        if (data.promptContext && data.promptContext.length > 7100) {
          ok = false;
          reason = `promptContext exceeds hard cap 7000 chars (${data.promptContext.length} chars)`;
        }
      }

      // Check no injection when needsWiki=false
      if (ok && !tc.expectedNeedsWiki) {
        if (data.citations.length > 0 || data.promptContext.length > 0) {
          ok = false;
          reason = `negative query should have 0 citations and empty promptContext`;
        }
      }

      if (ok) {
        passed++;
        const titles = data.citations.map((c) => c.title).join(', ') || 'None';
        const planner = data.metadata?.planner || 'unknown';
        console.log(`✅ [PASS] #${tc.id.toString().padStart(2, ' ')} [${tc.type.padEnd(11, ' ')}] "${tc.query}" -> [${titles}] (${duration}ms, ${planner})`);
      } else {
        console.log(`❌ [FAIL] #${tc.id.toString().padStart(2, ' ')} [${tc.type.padEnd(11, ' ')}] "${tc.query}" -> ${reason} (${duration}ms)`);
      }
    } catch (e) {
      console.log(`💥 [ERROR] #${tc.id} "${tc.query}":`, e.message);
    }
  }

  const passRate = ((passed / total) * 100).toFixed(1);
  const avgLatency = (totalLatency / total).toFixed(0);

  console.log(`\n===============================================================`);
  console.log(`📊 Suite Results: ${passed} / ${total} passed (${passRate}%)`);
  console.log(`⏱️  Average Latency: ${avgLatency}ms`);
  console.log(`===============================================================\n`);
}

runSuite().catch(console.error);
