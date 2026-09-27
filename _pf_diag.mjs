// 诊断：prefill 指示器的数据源是否正常（模拟 APP 的请求路径）
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);

// 经代理发一个 KB 式请求（prompt 里带长上下文，prefill 会持续几秒）
const p = fetch('http://127.0.0.1:31235/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gemma-4-26b-a4b-it',
    messages: [{ role: 'user', content: '[百科原文参考]\n' + '拉格朗日是法国数学家。'.repeat(120) + '\n[用户问题]\n拉格朗日是谁?' }],
    stream: true, temperature: 0, max_tokens: 30,
    chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none',
  }),
}).then(async (res) => {
  const rd = res.body.getReader();
  const d = new TextDecoder();
  let first = '';
  while (true) { const { done, value } = await rd.read(); if (done) break; if (!first) first = d.decode(value, { stream: true }).slice(0, 120); }
  return { firstChunk: first };
}).catch((e) => ({ err: e.message }));

const seen = [];
const timer = setInterval(async () => {
  try {
    const j = await (await fetch('http://127.0.0.1:31235/api/ttf/prefill')).json();
    const key = JSON.stringify(j);
    if (seen[seen.length - 1]?.key !== key) {
      seen.push({ key, at: ((Date.now() - t0) / 1000).toFixed(1) });
      log('探针:', key.slice(0, 180));
    }
  } catch (e) { log('探针错误:', e.message); }
}, 250);

const r = await Promise.race([p, new Promise((res) => setTimeout(() => res({ timeout: true }), 30000))]);
clearInterval(timer);
log('请求结束:', JSON.stringify(r).slice(0, 200));
log('探针状态序列:', seen.map((s) => `${s.at}s ${s.key.slice(0, 100)}`).join('\n'));
process.exit(0);
