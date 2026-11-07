/**
 * 文件夹检索的端到端自测（不经过 proxy，直接驱动索引引擎）。
 *
 * 用法：
 *   SIMPLEUI_EMBED_DIR=~/Library/Application\ Support/SimpleUI/models/embeddinggemma2 \
 *   SIMPLEUI_INDEX_DIR=/tmp/idx-test \
 *   node scripts/test_folder_index.mjs <文件夹> [查询1] [查询2] ...
 */
import os from 'os';
import path from 'path';

// 环境变量必须在 import 之前设置：engine/embed 在模块初始化时就读取了目录
if (!process.env.SIMPLEUI_INDEX_DIR) {
  process.env.SIMPLEUI_INDEX_DIR = path.join(os.tmpdir(), 'simpleui-index-test');
}
const { folderIndex } = await import('../server/folder_index/engine.js');
const { embedService } = await import('../server/embed_service.js');

const root = process.argv[2];
const queries = process.argv.slice(3);
if (!root) {
  console.error('usage: node scripts/test_folder_index.mjs <folder> [queries...]');
  process.exit(2);
}
const t0 = Date.now();
const item = await folderIndex.addFolder(root);
console.log(`索引 ${item.name} (${item.id}) root=${item.root}`);

let last = '';
const timer = setInterval(() => {
  const cur = folderIndex.list().find((x) => x.id === item.id);
  if (!cur) return;
  const p = cur.progress;
  const line = p ? `phase=${p.phase} ${p.done || 0}/${p.total || 0} chunks=${p.chunks || 0}` : 'idle';
  if (line !== last) {
    last = line;
    console.log(`  · ${line}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}, 400);

await folderIndex.start(item.id, { reason: 'manual' });
clearInterval(timer);

const done = folderIndex.list().find((x) => x.id === item.id);
console.log(`建索引完成：${((Date.now() - t0) / 1000).toFixed(1)}s  文件 ${done.files} 页 ${done.pages} 块 ${done.chunks}`);

for (const q of queries.length ? queries : ['TLB 虚页号和页内地址', '邻接矩阵求最小值']) {
  const r = await folderIndex.search(item.id, q, 6);
  console.log(`\n查询「${q}」 ${r.elapsedMs}ms`);
  for (const it of r.items) {
    console.log(`  ${it.score.toFixed(3)}  ${it.relPath}${it.page ? `  P${it.page}` : ''}  ${it.text.slice(0, 46).replace(/\n/g, ' ')}`);
  }
}

await embedService.unload();
if (process.env.KEEP_INDEX !== '1') {
  folderIndex.remove(item.id);
  console.log('\n（测试索引已清理，KEEP_INDEX=1 可保留）');
}
