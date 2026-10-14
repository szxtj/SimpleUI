// 离线模拟：用一段「真实 ASR 会产生的渐进输出序列」驱动状态机，
// 检验两件事：1) 已上屏的字不会被改写  2) 句末判定在什么时候触发
import { subtitleService } from './server/subtitle_service.js';
import { punctuationEngine } from './server/punctuation.js';

await punctuationEngine.load();
console.log('句末判定引擎:', punctuationEngine.isReady ? 'ready' : 'NOT READY ' + punctuationEngine.loadError);

const svc = subtitleService;
svc.isRunning = true;
svc.checkModelsReadiness = () => ({ allReady: true, missing: [], status: {} });
svc.ensureServersRunning = async () => true;
svc.callTranslate = async (s) => `【译】${s}`;
svc.broadcast = (evt, data) => {
  if (evt === 'finalized') {
    console.log(`   >>> FINALIZED (${data.reason}): "${data.source_text}"`);
  }
};

let queue = [];
svc.callAsr = async () => queue.shift() ?? '';

// 模拟一次「一口气说三句、中间不停顿」的 ASR 渐进输出。
// 刻意加入 ASR 常见的抖动：中途补逗号、改大小写、把已吐出的词重新断句。
const frames = [
  'So',
  'So the',
  'So, the first',
  'So the first thing',
  'So the first thing we',
  'So the first thing we need',
  'So the first thing we need to do',
  'So the first thing we need to do is',
  'So the first thing we need to do is to make',
  'So the first thing we need to do is to make sure',
  'So the first thing we need to do is to make sure the model',
  'So the first thing we need to do is to make sure the model runs',
  'So the first thing we need to do is to make sure the model runs on',
  'So the first thing we need to do is to make sure the model runs on the',
  'So the first thing we need to do is to make sure the model runs on the neural',
  'So the first thing we need to do is to make sure the model runs on the neural engine',
  'So the first thing we need to do is to make sure the model runs on the neural engine And',
  'So the first thing we need to do is to make sure the model runs on the neural engine And then',
  'So the first thing we need to do is to make sure the model runs on the neural engine. And then we',
  'So the first thing we need to do is to make sure the model runs on the neural engine. And then we can',
  'So the first thing we need to do is to make sure the model runs on the neural engine. And then we can test',
  'So the first thing we need to do is to make sure the model runs on the neural engine. And then we can test it',
  'So the first thing we need to do is to make sure the model runs on the neural engine. And then we can test it Now',
  'So the first thing we need to do is to make sure the model runs on the neural engine. And then we can test it Now let',
  'So the first thing we need to do is to make sure the model runs on the neural engine. And then we can test it Now let us',
  'So the first thing we need to do is to make sure the model runs on the neural engine. And then we can test it Now let us stop',
];

// 比较时忽略标点差异：ASR 事后补句点（engine -> engine.）不算改写
const norm = (w) => String(w).toLowerCase().replace(/^[.,!?;:。？！，]+|[.,!?;:。？！，]+$/g, '');
const normText = (t) => t.split(/\s+/).map(norm).join(' ');

let prevStable = '';
let regressions = 0;

for (const f of frames) {
  queue = [f];
  const r = await svc.processAudioChunk(Buffer.alloc(0), false);
  const stable = svc.segment.committed.join(' ');
  // 已确认文本必须只增不减（断句那一轮会被切走，属预期，不检查）
  if (!r.trimAudio && prevStable && !normText(stable).startsWith(normText(prevStable))) {
    regressions++;
    console.log(`   !!! 稳定前缀回退: "${prevStable}" -> "${stable}"`);
  }
  prevStable = stable;
  const tag = r.trimAudio ? ' [TRIM]' : '';
  console.log(`ASR: ${f.slice(-42).padEnd(42)} | stable="${stable.slice(-40)}"${tag}`);
}

console.log(`\n稳定前缀回退次数: ${regressions} (必须为 0)`);
console.log(`历史句数: ${svc.history.length}`);
for (const h of svc.history) console.log(`  - [${h.reason}] ${h.source_text}`);
