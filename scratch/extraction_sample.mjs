// 抽样报告生成器：对多个不同类型的词条抽取正文，写入 scratch/extraction_sample.md
// 用途：自查（干净/整洁/全面）+ 供人工复核
import fs from 'fs';
import {
  wikiService,
  assembleArticleContext,
  parseWikipediaDOM,
  toSimplifiedChinese,
} from '../server/wiki_service.js';

const ARTICLES = [
  ['哥德巴赫猜想', '哥德巴赫猜想是谁提出的？'],
  ['光速', '光速是多少'],
  ['周杰倫', '周杰伦的第一张专辑叫什么'], // 繁体条目，同时验证归一化
  ['第二次世界大战', '第二次世界大战是什么时候结束的'],
  ['奧斯卡金像獎', '奥斯卡金像奖一年举办几次'],
];

const CHECKS = [
  ['排序键残留 ♠', /♠/],
  ['长数字串(≥12位)', /\d{12,}/],
  ['维护横幅', /需要擴充|需要扩充|需要更多|維基百科所有|维基百科所有|請協助|请协助|查證|查证|中立性|關注度|关注度/],
  ['引用/脚注标记', /\[\d+\]|\[\s*[a-z]\s*\]|\[來源請求\]|\[来源请求\]/],
  ['参考文献段', /參考資料|参考资料|腳註|脚注|文獻來源/],
  ['外部链接段', /外部[連結链接]/],
  ['参见段', /參見|参见/],
  ['编辑链接', /編輯|编辑\]/],
  ['命名空间页', /Category:|Portal:|Template:|File:|分類:|分类:|Wikipedia:/],
  ['HTML标签残留', /<\w+[^>]*>|<\/\w+>/],
  ['HTML实体残留', /&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/],
];

const TRADITIONAL_HINTS =
  '倫傑學國說時間們來對開關門問題點電腦機構運動員歷史藝術術語書寫讀書買賣車馬鳥飛龍鳳觀點豐富鹽麗質無發長後裡東車貝樂譜醫藥廢棄錢財務實際標準確頭髮濕潤乾燥夢幻覺';

const OUT = [];
OUT.push('# 抽样报告：正文抽取质量自查\n');
OUT.push('> 生成时间：' + new Date().toLocaleString('zh-CN'));
OUT.push('> 抽取范围：Infobox + 引言(完整) + 正文小节（段落/列表/表格），其余一律排除\n');

await wikiService.setEnabled(true);
console.log('kiwix online =', wikiService.isOnline);

for (const [title, query] of ARTICLES) {
  const url = `http://127.0.0.1:31236/content/${wikiService.contentId}/${encodeURIComponent(title)}`;
  const html = await (await fetch(url)).text();
  const parsed = parseWikipediaDOM(html);
  const assembled = await assembleArticleContext(html, query);

  const text = assembled?.context || '';
  const flat = text.replace(/\n+/g, '\n');

  OUT.push(`\n---\n\n# 《${title}》\n`);
  OUT.push(`- 查询：${query}`);
  OUT.push(`- 模式：${assembled?.mode}　清洗后总字数：${text.length}　原始 HTML：${html.length}`);
  OUT.push(`- Infobox 行数：${parsed.infobox.length}　小节数：${parsed.sections.length}`);
  OUT.push(`- 小节：${parsed.sections.map((s) => s.title).join('、') || '（无）'}`);

  // 列表与表格是否被抓到
  const listLines = flat.split('\n').filter((l) => l.startsWith('· ')).length;
  const tableLines = flat.split('\n').filter((l) => l.startsWith('| ')).length;
  OUT.push(`- 列表条目行（· 开头）：${listLines}　表格行（| 开头）：${tableLines}`);

  OUT.push(`\n## 自动检查\n`);
  let bad = 0;
  for (const [name, re] of CHECKS) {
    const hits = (flat.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
    if (hits > 0) bad++;
    OUT.push(`- ${hits > 0 ? '❌' : '✅'} ${name}：${hits}`);
  }
  // 归一化检查（仅对繁体条目有意义）
  if (title === '周杰倫') {
    const trad = [...new Set([...text].filter((ch) => TRADITIONAL_HINTS.includes(ch)))];
    OUT.push(`- ${trad.length > 3 ? '❌' : '✅'} 繁体字形残留：${trad.length > 0 ? trad.join('') : '无'}`);
  }
  OUT.push(`\n**自动检查结果：${bad === 0 ? '✅ 全部通过' : '❌ 有 ' + bad + ' 项异常，见上'}**\n`);

  OUT.push(`\n## 抽取结果（全文）\n`);
  OUT.push('```\n' + text + '\n```\n');
}

fs.writeFileSync('/Users/justinxie/Projects/SimpleUI/scratch/extraction_sample.md', OUT.join('\n'), 'utf-8');
console.log('\n已写入 scratch/extraction_sample.md，共', OUT.join('').length, '字符');
process.exit(0);
