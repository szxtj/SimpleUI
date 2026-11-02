// 其它 provider 回归：TTF / Mference / DeepSeek 各真实跑一轮（走服务端 /turns 全链路）
const APP = 'http://127.0.0.1:31235';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, body) => {
  const r = await fetch(APP + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
};

async function runTurn(providerLabel, settingsPatch, maxWaitMs) {
  const base = await api('/api/sessions/settings').then(j => j.settings);
  const settings = JSON.parse(JSON.stringify(base));
  Object.assign(settings, settingsPatch.patch);
  if (settingsPatch.config) Object.assign(settings, settingsPatch.config);

  const empty = await api('/api/sessions/empty', { title: `回归-${providerLabel}`, origin: 'MAIN' });
  const sessionId = empty.sessionId || empty.mainSessionId;
  const turn = await api(`/api/sessions/${sessionId}/turns`, {
    text: settingsPatch.q,
    images: [],
    settings,
    lang: 'zh',
    origin: 'MAIN',
  });
  if (!turn?.sessionId) { console.log(`[${providerLabel}] 发起失败:`, JSON.stringify(turn).slice(0, 120)); return false; }
  const sid = turn.sessionId;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    await sleep(1500);
    const st = await api('/api/sessions/state');
    const arr = Array.isArray(st) ? st : st.sessions || Object.values(st);
    const s = arr.find(x => x.id === sid);
    if (!s) continue;
    const pending = (s.messages || []).some(m => m.pending);
    if (!pending) {
      const asst = [...(s.messages || [])].reverse().find(m => m.role === 'assistant');
      const err = asst?.error || '';
      console.log(`[${providerLabel}] ${Date.now() - t0}ms | 错误: ${err ? err.slice(0, 80) : '无'} | 思考: ${(asst?.reasoningContent || '').length}字 | 正文: ${(asst?.content || '').length}字`);
      console.log(`  正文预览: ${(asst?.content || '(空)').slice(0, 100).replace(/\n/g, ' ')}`);
      return !err && (asst?.content || '').length > 0;
    }
  }
  console.log(`[${providerLabel}] 超时`);
  return false;
}

async function main() {
  const cur = await api('/api/sessions/settings');
  const original = cur.settings;
  const results = {};

  // ---------- TTF ----------
  await api('/api/model/stop', { engine: 'maple-mlx' });
  await api('/api/model/config', { engine: 'turbo-fieldfare', ttfEnabled: true, mapleEnabled: false });
  await api('/api/model/start', { engine: 'turbo-fieldfare' });
  let ttfReady = false;
  for (let i = 0; i < 90; i++) {
    const st = await api('/api/model/status');
    if (st.ttf?.status === 'running') { ttfReady = true; console.log(`[TTF] 服务就绪（${i * 2}s）`); break; }
    await sleep(2000);
  }
  if (ttfReady) {
    results.ttf = await runTurn('TTF', {
      patch: { apiProvider: 'ttf', apiPort: 1235, modelId: 'gemma-4-26b-a4b-it', maxContext: 16384, maxTokens: 8192, temperature: 1.0, topP: 0.95, topK: 64, repetitionPenalty: 1.0, reasoningEffort: 'default', apiBaseUrl: '', enableThinking: true, enableWikiSearch: false },
      q: '用一句话说明什么是黑洞',
    }, 180000);
  }

  // ---------- Mference ----------
  await api('/api/model/stop', { engine: 'turbo-fieldfare' });
  await api('/api/model/config', { engine: 'mference', ttfEnabled: false, mferenceEnabled: true });
  await api('/api/model/start', { engine: 'mference' });
  let mfReady = false;
  for (let i = 0; i < 120; i++) {
    const st = await api('/api/model/status');
    if (st.mference?.status === 'running') { mfReady = true; console.log(`[Mference] 服务就绪（${i * 2}s）`); break; }
    await sleep(2000);
  }
  if (mfReady) {
    results.mference = await runTurn('Mference', {
      patch: { apiProvider: 'mference', apiPort: 1241, modelId: 'qwen3.6-35b-a3b', maxContext: 16384, maxTokens: 8192, temperature: 1.0, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 1.5, repetitionPenalty: 1.0, reasoningEffort: 'low', apiBaseUrl: '', enableThinking: true, enableWikiSearch: false },
      q: '用一句话说明什么是引力波',
    }, 240000);
  }

  // ---------- DeepSeek（仅当已配置 Key）----------
  const hasKey = Boolean(original.deepseekApiKey || original.deepseekConfig?.apiKey);
  if (hasKey) {
    results.deepseek = await runTurn('DeepSeek', {
      patch: { apiProvider: 'deepseek', enableThinking: false, enableWikiSearch: false },
      q: '用一句话说明什么是量子纠缠',
    }, 120000);
  } else {
    console.log('[DeepSeek] 未配置 API Key，跳过');
  }

  // ---------- 还原：Maple ----------
  await api('/api/model/stop', { engine: 'mference' });
  await api('/api/model/config', { engine: 'maple-mlx', mapleEnabled: true, ttfEnabled: false, mferenceEnabled: false });
  // 恢复 provider = maple（保存到存储，让主窗跟着回来）
  const s2 = await api('/api/sessions/settings');
  const ss = s2.settings;
  ss.apiProvider = 'maple';
  ss.apiPort = 1242; ss.apiBaseUrl = ''; ss.modelId = 'default_model';
  const mp = { ...(ss.mapleConfig || {}) };
  ss.maxContext = mp.maxContext ?? 16384; ss.maxTokens = mp.maxTokens ?? 8192;
  ss.temperature = mp.temperature ?? 1.0; ss.topP = mp.topP ?? 0.95; ss.topK = mp.topK ?? 40;
  ss.minP = mp.minP ?? 0.05; ss.presencePenalty = mp.presencePenalty ?? 0; ss.repetitionPenalty = mp.repetitionPenalty ?? 1.15;
  await api('/api/sessions/settings', { settings: ss });
  await api('/api/model/start', { engine: 'maple-mlx' });
  for (let i = 0; i < 60; i++) {
    const st = await api('/api/model/status');
    if (st.maple?.status === 'running') { console.log('[还原] Maple 已恢复 running'); break; }
    await sleep(2000);
  }

  console.log('=== 回归结果 ===');
  console.log(JSON.stringify(results));
  process.exitCode = Object.values(results).every(Boolean) ? 0 : 1;
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
