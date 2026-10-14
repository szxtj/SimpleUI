import { punctuationEngine, stripTerminalPunctuation, PUNCT_NAME } from './server/punctuation.js';

const ok = await punctuationEngine.load();
console.log('load:', ok, punctuationEngine.loadError || '');

const tests = [
  'how are you i am fine thank you',
  'What do you mean by that',
  'So the first thing we need to do is to make sure the model runs on the neural engine',
  'mr smith went to washington and then he came back',
];

for (const t of tests) {
  const r = await punctuationEngine.predict(t);
  console.log('IN :', t);
  console.log('    ', r.map((x) => `${x.word}[${x.name} ${x.prob.toFixed(2)}]`).join(' '));
}

console.log('\n--- 剥离 ASR 句末标点 ---');
for (const t of ['So we tested it. And then it worked!', 'Hello, world. How are you?']) {
  console.log(' ', JSON.stringify(t), '->', JSON.stringify(stripTerminalPunctuation(t)));
}

console.log('\n--- 逐词流式（右上下文 8 字符确认）---');
const words = 'So the first thing we need to do is to make sure the model runs on the neural engine And then we can test it'.split(' ');
for (let n = 12; n <= words.length; n++) {
  const pre = words.slice(0, n).join(' ');
  const r = await punctuationEngine.predict(pre);
  const conf = [];
  for (let i = 0; i < r.length; i++) {
    const endOff = words.slice(0, i + 1).join(' ').length;
    if (pre.length - endOff >= 8 && (r[i].tag === 2 || r[i].tag === 3)) conf.push(`${i}:${r[i].word}/${r[i].name}`);
  }
  console.log(`  n=${n} ${conf.length ? 'CONFIRM ' + conf.join(',') : '-'}`);
}
