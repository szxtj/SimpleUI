// 逐字节复刻 TurnStageIndicator 的 prefill 轮询逻辑（对真实端点）
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2) + 's', ...a);
const startedAt = Date.now(); // 模拟 msg.prefillStartedAt

const t = (k) => ({ prefillLoading: '正在载入上下文', stageQueued: '等待模型空闲' }[k] || k);
const isFresh = (at) => {
  if (at === undefined || at === null || at === '') return false;
  const ts = typeof at === 'number' ? at : Date.parse(at.endsWith('Z') ? at : at + 'Z');
  return !Number.isNaN(ts) && ts >= startedAt - 1500;
};

let lastView = null;
const render = (v) => {
  if (!v) { log('渲染 → （空，指示器不显示）'); return; }
  log('渲染 →', v.kind === 'ring' ? `◍ ${v.text} · ${v.tokens} tokens` : `🌀 ${v.text}`);
};

const timer = setInterval(async () => {
  try {
    const res = await fetch('http://127.0.0.1:31235/api/ttf/prefill');
    if (res.ok) {
      const j = await res.json();
      let v = null;
      if (j && j.found && j.inFlight && isFresh(j.at)) {
        if (j.queued) {
          v = { kind: 'spinner', text: t('stageQueued'), elapsed: ((Date.now() - startedAt) / 1000).toFixed(1) };
        } else if (j.promptTokens > 0) {
          const elapsedSec = Math.max(0, (Date.now() - startedAt) / 1000);
          const rate = (j.rate ?? 0) > 0 ? j.rate : 30;
          const percent = Math.min(99, Math.round((elapsedSec * rate * 100) / j.promptTokens));
          v = { kind: 'ring', text: `${t('prefillLoading')} ${percent}%`, percent, tokens: j.promptTokens.toLocaleString() };
        }
      }
      if (JSON.stringify(v) !== JSON.stringify(lastView)) { render(v); lastView = v; }
    }
  } catch (e) { /* noop */ }
}, 250);

// 模拟 APP 的流式请求（prefill 会持续数秒）
const p = fetch('http://127.0.0.1:31235/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gemma-4-26b-a4b-it',
    messages: [{ role: 'user', content: '[百科原文参考]\n' + '拉格朗日是法国数学家。'.repeat(120) + '\n[用户问题]\n拉格朗日是谁?' }],
    stream: true, temperature: 0, max_tokens: 30,
    chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none',
  }),
}).then(async (res) => { const rd = res.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; } return {}; });

await Promise.race([p, new Promise((res) => setTimeout(() => res({}), 40000))]);
clearInterval(timer);
process.exit(0);
