// End-to-end full chain verification test

async function testFullChain() {
  console.log('--- Step 1: Querying RAG Context ---');
  const userQuery = '小米集团有多少人？';
  const ragRes = await fetch('http://127.0.0.1:31235/api/wiki/rag-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: userQuery }),
  });

  const rag = await ragRes.json();
  console.log('Needs Wiki:', rag.needsWiki);
  console.log('Citations:', rag.citations.map((c) => c.title));

  const promptToSend = `${rag.promptContext}\n\n[用户问题]\n${userQuery}\n\n[请结合上述知识库参考资料准确客观地回答用户问题，直接给出相关数据与事实]`;

  console.log('\n--- Step 2: Sending to Large Model (via Proxy / TurboFieldfare) ---');
  // Send to proxy at 31235 with target port 1235 (or direct to LM Studio 1234 if 1235 isn't up)
  let targetUrl = 'http://127.0.0.1:31235/v1/chat/completions';
  let headers = {
    'Content-Type': 'application/json',
    'x-target-port': '1235',
  };

  // Check which port (1235 or 1234) is online
  let modelToUse = 'gemma-4-26b-a4b-it';
  try {
    const health1235 = await fetch('http://127.0.0.1:1235/health', { method: 'GET' });
    if (!health1235.ok) throw new Error('1235 not ready');
  } catch (e) {
    console.log('Port 1235 not responding, testing direct to 1234 (LM Studio)...');
    targetUrl = 'http://127.0.0.1:1234/v1/chat/completions';
    headers = { 'Content-Type': 'application/json' };
    modelToUse = 'qwen3.5-2b-optiq';
  }

  const payload = {
    model: modelToUse,
    messages: [{ role: 'user', content: promptToSend }],
    temperature: 0.2,
    max_tokens: 512,
  };

  const t0 = Date.now();
  const llmRes = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const duration = Date.now() - t0;
  if (!llmRes.ok) {
    console.error('LLM request failed:', llmRes.status, await llmRes.text());
    return;
  }

  const llmData = await llmRes.json();
  const answer = llmData.choices?.[0]?.message?.content || '';

  console.log(`\n--- Step 3: LLM Response (${duration}ms) ---`);
  console.log(answer);
}

testFullChain().catch(console.error);
