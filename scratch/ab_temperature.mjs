// 主力模型实体规划：temperature 0 vs 1 对照
// 测试问题与提示词中的 3 个示例完全无关
// 温度 0 跑 1 次；温度 1 跑 2 次（观察稳定性）。全部串行（TTF 不支持并发）
import { callMainModel, MAIN_PLANNER_SYSTEM, MAIN_PLANNER_USER } from '../server/wiki_service.js';

// 与示例（特斯拉CEO / 中国第一颗原子弹 / 哥德巴赫猜想）无任何关联的新问题
const QUESTIONS = [
  ['黄河的发源地在哪个省', '黄河 / 青海省'],
  ['《史记》的作者是谁', '史记 / 司马迁'],
  ['人体最大的器官是什么', '皮肤'],
  ['原子序数为1的元素是什么', '氢'],
  ['第一次世界大战爆发于哪一年', '第一次世界大战'],
  ['月球绕地球一圈大约需要多久', '月球 / 朔望月'],
  ['世界上最长的河流是哪一条', '尼罗河 / 亚马逊河'],
  ['谁提出了进化论', '进化论 / 查尔斯·达尔文'],
  ['故宫位于哪个城市', '北京故宫'],
  ['二氧化碳的化学式是什么', '二氧化碳'],
  ['iPhone 是哪个公司生产的', '苹果公司 / iPhone'],
  ['中国四大名著包括哪些', '四大名著'],
];

async function run(q, temperature) {
  const out = await callMainModel(MAIN_PLANNER_USER(q), {
    systemPrompt: MAIN_PLANNER_SYSTEM,
    maxTokens: 64,
    timeoutMs: 40000,
    temperature,
  });
  return (out || '').replace(/```json/gi, '').replace(/```/g, '').trim();
}

for (const [label, temp, times] of [['temperature=0', 0, 1], ['temperature=1', 1.0, 2]]) {
  console.log(`\n${'='.repeat(72)}\n【${label}】\n${'='.repeat(72)}`);
  for (const [q, expect] of QUESTIONS) {
    const runs = [];
    for (let i = 0; i < times; i++) runs.push(await run(q, temp));
    const stable = times > 1 ? (runs[0] === runs[1] ? '' : '  ⚠️两次不一致') : '';
    console.log(`  ${q}`);
    console.log(`      期望≈ ${expect}`);
    runs.forEach((r, i) => console.log(`      实际${times > 1 ? `#${i + 1}` : '  '}  ${r}${i === 0 ? stable : ''}`));
  }
}
process.exit(0);
