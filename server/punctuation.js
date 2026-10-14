// 独立句末判定引擎 (Sentence-End Detection)
//
// 用途：给实时双语字幕提供「这一句话说完了吗」的模型化判断，取代原先按静音时长机械切分。
//
// 模型：Edge-Punct-Casing（sherpa-onnx 的 online punctuation 封装，Apache-2.0）
//   上游 frankyoujian/Edge-Punct-Casing，CNN-BiLSTM，对**每个英文单词**预测
//   标点（NONE / COMMA / PERIOD / QUESTION）与大小写。
//
// 为什么必须由独立模型判定，而不能读 ASR 自己的标点：
//   ASR 每次重跑累积音频都会重新加标点（会去改已经吐出的字），它的标点是**不稳定中间态**；
//   本模块接受的是「已被 Local-Agreement 确认稳定的前缀」，且只用它自己的预测来打句末，
//   不与 ASR 的标点做任何妥协。
//
// ONNX 推理契约（与 sherpa-onnx csrc/online-punctuation-cnn-bilstm-impl.h 一致）：
//   输入 token_ids  int32 [N, 200]   —— BPE 序列，<s>=1 开头、</s>=2 结尾，右侧补 0
//   输入 valid_ids  int32 [N, 200]   —— 每个单词只有**首个 subword** 记 1，其余 subword 与 padding 记 0
//   输入 label_lens int32 [N]        —— valid_ids 中 1 的个数（含 <s> 与 </s>）
//   输出 active_punct_logits float [词数, 4]  —— 行数恒等于输入单词数（不含 <s>/</s>）
//   输出 active_case_logits  float [词数, 4]

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const USER_DIR = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');

export const PUNCT_DIR = path.join(USER_DIR, 'models', 'subtitles_pipeline', 'punct');
export const PUNCT_MODEL_FILE = 'model.int8.onnx';
export const PUNCT_VOCAB_FILE = 'bpe.vocab';

// 与 sherpa-onnx 的 kMaxSeqLen 一致，改动前先确认模型元数据
const MAX_SEQ_LEN = 200;
const UNK = 0;
const BOS = 1;
const EOS = 2;

export const PUNCT_NONE = 0;
export const PUNCT_COMMA = 1;
export const PUNCT_PERIOD = 2;
export const PUNCT_QUESTION = 3;

export const PUNCT_NAME = {
  [PUNCT_NONE]: 'NONE',
  [PUNCT_COMMA]: 'COMMA',
  [PUNCT_PERIOD]: 'PERIOD',
  [PUNCT_QUESTION]: 'QUESTION',
};

// 句末标点：只有这两类能触发断句。逗号不能断句，它只是句法线索。
export const SENTENCE_END_TAGS = new Set([PUNCT_PERIOD, PUNCT_QUESTION]);

let ort = null;
async function getOrt() {
  if (ort) return ort;
  ort = (await import('onnxruntime-node')).default;
  return ort;
}

/**
 * sentencepiece BPE 编码器。
 *
 * bpe.vocab 是 5000 行 `piece\tscore`。与 sentencepiece 一致：单词前置 U+2581（▁），
 * 然后按 score 从高到低反复合并相邻符号；合并规则由词表中所有可二分拆的 piece 推导。
 */
class BpeEncoder {
  constructor(vocabPath) {
    const raw = fs.readFileSync(vocabPath, 'utf-8');
    this.token2id = new Map();
    let id = 0;
    for (const line of raw.split('\n')) {
      const l = line.replace(/\r$/, '');
      if (!l) continue;
      const idx = l.indexOf('\t');
      const piece = idx === -1 ? l : l.slice(0, idx);
      this.token2id.set(piece, id++);
    }
    // 合并规则：对每个多字符 piece 枚举所有二分拆，两侧都在词表内才成立，取最高分
    this.rules = new Map();
    for (const line of raw.split('\n')) {
      const l = line.replace(/\r$/, '');
      if (!l) continue;
      const idx = l.indexOf('\t');
      const piece = idx === -1 ? l : l.slice(0, idx);
      const score = idx === -1 ? 0 : Number(l.slice(idx + 1)) || 0;
      if ([...piece].length <= 1) continue;
      const chars = [...piece];
      for (let i = 1; i < chars.length; i++) {
        const left = chars.slice(0, i).join('');
        const right = chars.slice(i).join('');
        if (!this.token2id.has(left) || !this.token2id.has(right)) continue;
        const key = left + '\u0000' + right;
        const prev = this.rules.get(key);
        if (prev === undefined || score > prev.score) {
          this.rules.set(key, { score, merged: piece });
        }
      }
    }
  }

  encode(word) {
    const syms = [...'\u2581' + word];
    while (syms.length > 1) {
      let bestScore = -Infinity;
      let bestIdx = -1;
      let bestMerged = null;
      for (let i = 0; i < syms.length - 1; i++) {
        const r = this.rules.get(syms[i] + '\u0000' + syms[i + 1]);
        if (r && r.score > bestScore) {
          bestScore = r.score;
          bestIdx = i;
          bestMerged = r.merged;
        }
      }
      if (bestIdx < 0) break;
      syms.splice(bestIdx, 2, bestMerged);
    }
    return syms.map((s) => (this.token2id.has(s) ? this.token2id.get(s) : UNK));
  }
}

/**
 * 句末判定引擎。模型缺失或加载失败时全部降级为「判定不可用」（isReady=false），
 * 上层据此回退到保守策略，绝不静默给出错误断句。
 */
export class PunctuationEngine {
  constructor() {
    this.session = null;
    this.encoder = null;
    this.loadError = null;
  }

  get isReady() {
    return Boolean(this.session && this.encoder);
  }

  async load() {
    if (this.session) return true;
    const modelPath = path.join(PUNCT_DIR, PUNCT_MODEL_FILE);
    const vocabPath = path.join(PUNCT_DIR, PUNCT_VOCAB_FILE);
    if (!fs.existsSync(modelPath) || !fs.existsSync(vocabPath)) {
      this.loadError = `句末判定模型缺失: ${modelPath}`;
      return false;
    }
    try {
      const ortLib = await getOrt();
      this.encoder = new BpeEncoder(vocabPath);
      this.session = await ortLib.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        intraOpNumThreads: 1,
      });
      return true;
    } catch (e) {
      this.loadError = `句末判定模型加载失败: ${e.message}`;
      this.session = null;
      this.encoder = null;
      return false;
    }
  }

  /**
   * 对一段文本逐词预测标点。onnxruntime-node 的 run() 是异步的，故本方法为 async。
   * @returns {Promise<Array<{word:string, tag:number, name:string, prob:number}>>} 与输入词序一一对应
   */
  async predict(text) {
    if (!this.isReady) return [];
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    const tokens = [BOS];
    const valids = [1];
    for (const w of words) {
      const wt = this.encoder.encode(w);
      if (tokens.length + wt.length > MAX_SEQ_LEN - 1) break; // 留出 </s> 位置
      tokens.push(...wt);
      valids.push(1);
      for (let k = 1; k < wt.length; k++) valids.push(0); // 仅首个 subword 有效
    }
    tokens.push(EOS);
    valids.push(1);
    const labelLen = valids.reduce((a, b) => a + b, 0);

    const pad = MAX_SEQ_LEN - tokens.length;
    for (let i = 0; i < pad; i++) {
      tokens.push(0);
      valids.push(0);
    }

    const ortLib = ort;
    const feeds = {
      token_ids: new ortLib.Tensor('int32', Int32Array.from(tokens), [1, MAX_SEQ_LEN]),
      valid_ids: new ortLib.Tensor('int32', Int32Array.from(valids), [1, MAX_SEQ_LEN]),
      label_lens: new ortLib.Tensor('int32', Int32Array.from([labelLen]), [1]),
    };

    const out = await this.session.run(feeds);
    const punct = out.active_punct_logits;
    if (!punct) return [];
    const rows = punct.dims[0];
    const data = punct.data;

    const result = [];
    for (let i = 0; i < words.length && i < rows; i++) {
      const base = i * 4;
      let best = 0;
      for (let c = 1; c < 4; c++) {
        if (data[base + c] > data[base + best]) best = c;
      }
      // softmax 置信度
      let max = -Infinity;
      for (let c = 0; c < 4; c++) max = Math.max(max, data[base + c]);
      let sum = 0;
      for (let c = 0; c < 4; c++) sum += Math.exp(data[base + c] - max);
      const prob = Math.exp(data[base + best] - max) / sum;

      result.push({ word: words[i], tag: best, name: PUNCT_NAME[best], prob });
    }
    return result;
  }
}

export const punctuationEngine = new PunctuationEngine();

/**
 * 剥离 ASR 自带的句末标点，交给独立模型重新判定。
 * 只去掉「句末类」标点（. ? ! 。 ？ ！），刻意保留逗号与大小写：
 *   - 逗号是句内句法线索，模型需要它；
 *   - 大小写是模型判断句首/专名的依据，实测全小写输入会让 case 预测明显漂移。
 */
export function stripTerminalPunctuation(text) {
  return text
    .replace(/[.?!。？！]+(\s|$)/g, ' ')
    .replace(/[.?!。？！]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
