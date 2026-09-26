// 主力模型实体规划：中文指令 vs 英文指令 vs 零示例，实测对比
// 采样参数统一遵循官方建议 temperature=1.0 / top_p=0.95 / top_k=64
// 全部串行（TTF 不支持并发）
import { callMainModel } from '../server/wiki_service.js';

// 三份示例（中英对照，用于隔离"语言"变量）
const EX = [
  ['特斯拉现在的CEO是谁', '["特斯拉公司", "埃隆·马斯克"]'],
  ['中国第一颗原子弹爆炸是在什么时候', '["596工程"]'],
  ['哥德巴赫猜想是谁提出的？主要是讲的什么内容？', '["哥德巴赫猜想"]'],
];

const SYS_ZH = `你是百科检索关键词提取器。从用户提问中提取需要在中文百科全书检索的条目名称。
只输出 JSON：{"target_articles": ["条目名"]}。
默认只给 1 个条目；仅当提问确实同时涉及两个彼此独立、且都必须分别查证的实体时才给 2 个。
严禁为了凑数而推测提问中并未出现的实体。
条目名必须是百科中真实存在的规范名称：人物用全名，机构/作品/事件用通行名，存在歧义时加限定词。
不要保留疑问词、代词或解释性文字。`;

const SYS_EN = `You are an encyclopedia search-term extractor. From the user's question, extract the article titles to look up in a Chinese encyclopedia.
Output only JSON: {"target_articles": ["title"]}.
Give exactly 1 title by default. Give 2 only when the question genuinely involves two independent entities that both must be looked up separately.
Never invent entities that do not appear in the question just to fill a slot.
Titles must be real canonical article names in the encyclopedia: full names for people, common names for organizations/works/events, with a qualifier when ambiguous.
Do not keep interrogative words, pronouns or explanations.`;

function buildExamples(lang) {
  return EX.map(([q, a]) =>
    lang === 'zh' ? `问：${q}\n答：{"target_articles": ${a}}` : `Q: ${q}\nA: {"target_articles": ${a}}`
  ).join('\n');
}

function buildUser(lang, q, withExamples) {
  if (lang === 'zh') {
    return withExamples ? `${buildExamples('zh')}\n\n问：${q}\n答：` : `问：${q}\n答：`;
  }
  return withExamples ? `${buildExamples('en')}\n\nQ: ${q}\nA:` : `Q: ${q}\nA:`;
}

// 全部为示例中未出现过的提问
const QUESTIONS = [
  ['太阳系中最大的行星是哪一颗', '木星'],
  ['《红楼梦》的作者是谁', '红楼梦 / 曹雪芹'],
  ['人类第一次登上月球是哪一年', '阿波罗11号'],
  ['世界上最高的山峰叫什么名字', '珠穆朗玛峰'],
  ['水的化学式是什么', '水'],
  ['第二次世界大战是什么时候结束的', '第二次世界大战'],
  ['万有引力定律是谁提出的', '万有引力定律 / 牛顿'],
  ['相对论是谁提出的', '相对论 / 爱因斯坦'],
  ['谁发现了青霉素', '青霉素 / 弗莱明'],
  ['世界上最大的海洋是哪一个', '太平洋'],
];

const CONFIGS = [
  ['中文+3示例', 'zh', true],
  ['英文+3示例', 'en', true],
  ['中文+0示例', 'zh', false],
];

for (const [label, lang, withEx] of CONFIGS) {
  console.log(`\n${'='.repeat(70)}\n【${label}】\n${'='.repeat(70)}`);
  for (const [q, expect] of QUESTIONS) {
    const sys = lang === 'zh' ? SYS_ZH : SYS_EN;
    const out = await callMainModel(buildUser(lang, q, withEx), {
      systemPrompt: sys,
      maxTokens: 64,
      timeoutMs: 40000,
    });
    const clean = (out || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    console.log(`  ${q}\n     期望≈ ${expect}\n     实际   ${clean}`);
  }
}
process.exit(0);
