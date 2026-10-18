// SaT 断句冒烟测试：使用已下载的 CoreML helper + XLM-R tokenizer。
// 运行：node scripts/test_subtitle_segmentation.js
import assert from 'assert';
import path from 'path';
import os from 'os';
import { SubtitleMlHelper } from '../server/subtitles/ml_helper.js';
import { SatSegmenter } from '../server/subtitles/segmenter.js';

const modelsDir =
  process.env.SUBTITLE_MODELS_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'SimpleUI', 'models', 'subtitles_pipeline');

const helper = new SubtitleMlHelper({
  helperPath: path.resolve('bin/subtitle_ml_helper'),
  modelsDir,
  onFatal: (err) => {
    console.error('helper fatal:', err);
    process.exit(1);
  },
});

await helper.start();
const segmenter = new SatSegmenter({
  tokenizerPath: path.join(modelsDir, 'xlmr_tokenizer.json'),
  helper,
  threshold: 0.5,
  lookaheadTokens: 4,
});
await segmenter.init();

const cases = [
  {
    name: 'en',
    text:
      "experience versus like iPad in landscape? Because I think it's interesting that the media apps, TV, for example, uses a tab bar in fully open on Duo, but there's a sidebar on iPad, Grant, what's the reasoning there?",
    expected: 3,
  },
  {
    name: 'zh',
    text:
      '因为我觉得媒体应用这一点挺有意思的，以电视为例，它在 Duo 上完全打开时会使用一个标签栏，不过打开时会有一个侧边栏。iPad 上的应用是可以调整大小的，对吧？',
    expected: 2,
  },
  {
    name: 'ja',
    text:
      'メディアアプリは面白いと思います。テレビを例にすると、Duo で完全に開くとタブバーが表示されます。iPad ではサイドバーがあります。',
    expected: 3,
  },
];

let failed = false;
for (const c of cases) {
  const { sentences } = await segmenter.split(c.text, { final: true });
  console.log(`[${c.name}]`, JSON.stringify(sentences));
  try {
    assert.strictEqual(sentences.length, c.expected);
  } catch {
    failed = true;
    console.error(`[${c.name}] expected ${c.expected} sentences, got ${sentences.length}`);
  }
}
helper.close();
if (failed) process.exit(1);
console.log('SaT segmentation smoke test passed');
