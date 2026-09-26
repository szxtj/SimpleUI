// 验证「核心实体回现校验」是否可行：
//  hallucination 候选《格奥尔格·康托尔》的正文里，到底有没有出现主实体「哥德巴赫」？
import { wikiService, assembleArticleContext, toSimplifiedChinese } from '../server/wiki_service.js';

await wikiService.startService();
console.log('kiwix online =', wikiService.isOnline, '| contentId =', wikiService.contentId);

const TITLES = ['格奥尔格·康托尔', '哥德巴赫猜想', '康托尔集'];
const PRIMARY = '哥德巴赫';
const ALIASES = ['哥德巴赫', '哥德巴赫猜想', '戈德巴赫', '古德巴赫'];

for (const title of TITLES) {
  const url = `http://127.0.0.1:31236/content/${wikiService.contentId}/${encodeURIComponent(title)}`;
  const res = await fetch(url);
  const html = await res.text();
  const plain = html.replace(/<[^>]+>/g, ' ');
  const norm = toSimplifiedChinese(plain);
  console.log(`\n===== ${title} =====`);
  console.log('  原始 HTML 长度 =', html.length, '| 纯文本长度 =', plain.length);
  for (const a of ALIASES) {
    const c = (norm.match(new RegExp(a, 'g')) || []).length;
    console.log(`  「${a}」出现 ${c} 次`);
  }

  const ctx = await assembleArticleContext(html, '哥德巴赫猜想是谁提出的？主要是讲的什么内容？');
  if (ctx) {
    console.log('  assembleArticleContext -> mode =', ctx.mode, '| 文本长度 =', ctx.text?.length ?? '?');
    console.log('  送入 MRC 的文本前 600 字:\n', (ctx.text || '').slice(0, 600).replace(/\n+/g, '\n'));
  } else {
    console.log('  assembleArticleContext -> null');
  }
}
process.exit(0);
