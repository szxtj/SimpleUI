// 诊断主力模型在 MRC 场景下的真实表现：长 prompt + 关思考
const URL = 'http://127.0.0.1:1235/v1/chat/completions';
const MODEL = 'gemma-4-26b-a4b-it';

const filler = '哥德巴赫猜想是数学界存在时间最久的未解问题之一。'.repeat(1);
function mkPrompt(chars) {
  const body = filler.repeat(Math.ceil(chars / filler.length)).slice(0, chars);
  return `从下列内容中抽取能回答问题的一句事实。\n[问题] 哥德巴赫猜想是谁提出的？\n[内容]\n${body}\n\n[输出]`;
}

async function run(label, payload, timeoutMs = 90000) {
  const t = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(payload),
    });
    clearTimeout(timer);
    const txt = await res.text();
    console.log(`${label}  ${Date.now() - t}ms  status=${res.status}`);
    console.log('   ', txt.slice(0, 400));
  } catch (e) {
    clearTimeout(timer);
    console.log(`${label}  ${Date.now() - t}ms  ERROR: ${e.name} ${e.message}`);
  }
}

console.log('--- 1) 短 prompt，带 chat_template_kwargs ---');
await run('short+ctk', {
  model: MODEL,
  messages: [{ role: 'user', content: '只回答：法国的首都是哪座城市？' }],
  temperature: 0,
  max_tokens: 120,
  chat_template_kwargs: { enable_thinking: false },
});

console.log('\n--- 2) 短 prompt，不带 chat_template_kwargs ---');
await run('short-ctk', {
  model: MODEL,
  messages: [{ role: 'user', content: '只回答：法国的首都是哪座城市？' }],
  temperature: 0,
  max_tokens: 120,
});

console.log('\n--- 3) 长 prompt (~6000字)，带 chat_template_kwargs ---');
await run('long+ctk', {
  model: MODEL,
  messages: [{ role: 'user', content: mkPrompt(6000) }],
  temperature: 0,
  max_tokens: 120,
  chat_template_kwargs: { enable_thinking: false },
}, 120000);

console.log('\n--- 4) 长 prompt (~6000字)，不带 chat_template_kwargs ---');
await run('long-ctk', {
  model: MODEL,
  messages: [{ role: 'user', content: mkPrompt(6000) }],
  temperature: 0,
  max_tokens: 120,
}, 120000);

process.exit(0);
