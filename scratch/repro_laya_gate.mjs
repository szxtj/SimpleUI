// 单独验证 LAYA System 1 门禁：这是唯一在上一轮复现中未被真正测到的环节
import { spawn } from 'child_process';
import { judgeNeedsWikiWithLaya, toSimplifiedChinese } from '../server/wiki_service.js';

const PY = '/opt/homebrew/Caskroom/miniforge/base/bin/python3';
const child = spawn(PY, ['server/laya_mlx_server.py'], {
  cwd: '/Users/justinxie/Projects/SimpleUI',
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write('[LAYA-out] ' + d));
child.stderr.on('data', (d) => process.stdout.write('[LAYA-err] ' + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(maxMs = 60000) {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    try {
      const r = await fetch('http://127.0.0.1:1236/health', { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const j = await r.json();
        console.log('LAYA health =', JSON.stringify(j));
        return j.ready === true;
      }
    } catch {}
    await sleep(1000);
  }
  console.log('LAYA 启动超时');
  return false;
}

const ready = await waitHealth();
console.log('LAYA model ready =', ready, '\n');

const QUERIES = [
  '哥德巴赫猜想是谁提出的？主要是讲的什么内容？',
  '哥德巴赫猜想是谁提出的',
  '哥德巴赫猜想',
  '你好',
  '帮我写个冒泡排序',
  '今天天气怎么样',
  '苹果公司什么时候成立的',
];

for (const q of QUERIES) {
  const n = toSimplifiedChinese(q);
  const r = await judgeNeedsWikiWithLaya(n);
  const verdict =
    r === true ? '✅ 进入 RAG' : r === false ? '❌ 门禁放行(不检索知识库)' : '⚠️ LAYA 不可达/返回 null';
  console.log(`Q: ${q}\n   -> ${JSON.stringify(r)}  ${verdict}\n`);
}

child.kill('SIGTERM');
process.exit(0);
