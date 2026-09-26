// 启动 LAYA 服务并实测「闲聊 vs 知识问答」意图分类
// 严格串行（主力模型概念同理，LAYA 亦单线程）
import { spawn } from 'child_process';
import { judgeNeedsWikiWithLaya, toSimplifiedChinese } from '../server/wiki_service.js';

const PY = '/opt/homebrew/Caskroom/miniforge/base/bin/python3';

// 若 1236 已在监听（如 APP 已自动启动 LAYA），直接挂载，不再另起进程
let child = null;
let alreadyRunning = false;
try {
  const probe = await fetch('http://127.0.0.1:1236/health', { signal: AbortSignal.timeout(1500) });
  alreadyRunning = probe.ok;
  if (alreadyRunning) console.log('检测到 LAYA 已在运行，直接挂载现有服务');
} catch {}

if (!alreadyRunning) {
  child = spawn(PY, ['server/laya_mlx_server.py'], {
    cwd: '/Users/justinxie/Projects/SimpleUI',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/^(?:https?_proxy|all_proxy|allproxy)$/i.test(k)
      )
    ),
  });
  child.stdout.on('data', (d) => process.stdout.write('[LAYA-out] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[LAYA-err] ' + d));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(maxMs = 120000) {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    try {
      const r = await fetch('http://127.0.0.1:1236/health', { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const j = await r.json();
        if (j.ready === true) {
          console.log('✅ LAYA 模型已就绪:', JSON.stringify(j));
          return true;
        }
        if (Date.now() - t > 30000) console.log('  等待模型加载...', JSON.stringify(j));
      }
    } catch {}
    await sleep(2000);
  }
  try {
    const r = await fetch('http://127.0.0.1:1236/health', { signal: AbortSignal.timeout(1500) });
    console.log('❌ LAYA 未就绪，最后状态:', JSON.stringify(await r.json()));
  } catch {
    console.log('❌ LAYA 服务不可达');
  }
  return false;
}

const ready = await waitReady();
console.log('');

const CHITCHAT = [
  '你好',
  '今天天气真好啊',
  '谢谢你的帮助',
  '你觉得这个主意怎么样',
  '帮我写个冒泡排序',
  '把下面这段话翻译成英文',
  '我心情不太好',
  '再见',
];

const KNOWLEDGE = [
  '哥德巴赫猜想是谁提出的',
  '黄河的发源地在哪个省',
  '《史记》的作者是谁',
  '人体最大的器官是什么',
  '第一次世界大战爆发于哪一年',
  '谁提出了进化论',
  '故宫位于哪个城市',
  '二氧化碳的化学式是什么',
];

if (ready) {
  let cOk = 0;
  let kOk = 0;
  console.log('--- 应为「不检索」的闲聊/代码类 ---');
  for (const q of CHITCHAT) {
    const r = await judgeNeedsWikiWithLaya(toSimplifiedChinese(q));
    const ok = r === false;
    if (ok) cOk++;
    console.log(`  ${ok ? '✅' : '❌'} ${q}  -> needsWiki=${JSON.stringify(r)}`);
  }
  console.log(`  小计 ${cOk}/${CHITCHAT.length}\n`);

  console.log('--- 应为「检索」的知识问答类 ---');
  for (const q of KNOWLEDGE) {
    const r = await judgeNeedsWikiWithLaya(toSimplifiedChinese(q));
    const ok = r === true;
    if (ok) kOk++;
    console.log(`  ${ok ? '✅' : '❌'} ${q}  -> needsWiki=${JSON.stringify(r)}`);
  }
  console.log(`  小计 ${kOk}/${KNOWLEDGE.length}`);
  console.log(`\n总计 ${cOk + kOk}/${CHITCHAT.length + KNOWLEDGE.length}`);
}

if (child) child.kill('SIGTERM');
process.exit(0);
