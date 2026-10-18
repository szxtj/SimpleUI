// SOTA 断句：XLM-R fast tokenizer (offset mapping) + SaT-3l-sm CoreML helper。
// 只用模型概率和 token 的字符 offset 切分，不做正则、不做词数 cap、不做 decode 回拼。

import { createRequire } from 'module';
import { SubtitleError } from './ml_helper.js';

const require = createRequire(import.meta.url);
const { Tokenizer } = require('tokenizers');

const LANG_NAMES = { en: '英语', zh: '中文', ja: '日文' };

export class SatSegmenter {
  constructor({ tokenizerPath, helper, threshold = 0.5, lookaheadTokens = 4 }) {
    this.tokenizerPath = tokenizerPath;
    this.helper = helper;
    this.threshold = threshold;
    this.lookaheadTokens = lookaheadTokens;
    this.tokenizer = null;
  }

  async init() {
    this.tokenizer = await Tokenizer.fromFile(this.tokenizerPath);
  }

  /**
   * 对 draft 跑一次 SaT，返回可提交的完整句。
   * final=false：保留最后一段，只提交距离末尾至少 lookaheadTokens 个 token 的边界。
   * final=true：提交到文本末尾（包括最后一段）。
   */
  async split(draft, { final = false } = {}) {
    const text = String(draft || '');
    if (!text.trim()) return { sentences: [], consumed: 0 };
    if (!this.tokenizer) {
      throw new SubtitleError('segmentation', 'SAT_NOT_INITIALIZED', 'SaT tokenizer 未初始化');
    }
    const encoding = await this.tokenizer.encode(text, null, { addSpecialTokens: false });
    const ids = encoding.getIds();
    const offsets = encoding.getOffsets();
    if (!Array.isArray(ids) || ids.length === 0) return { sentences: [], consumed: 0 };
    if (offsets.length !== ids.length) {
      throw new SubtitleError('segmentation', 'SAT_OFFSET_COUNT', 'tokenizer offset 数量与 ids 不一致');
    }
    if (ids.length > 510) {
      throw new SubtitleError(
        'segmentation',
        'SAT_INPUT_TOO_LONG',
        `SaT 输入过长: ${ids.length} tokens (max 510)`
      );
    }
    const probs = await this.helper.segment(ids);
    if (probs.length < ids.length + 2) {
      throw new SubtitleError('segmentation', 'SAT_BAD_PROBS', 'SaT 返回的概率长度不足');
    }

    // probs[0] 是 BOS，probs[i+1] 对应 ids[i]。
    const boundaries = [];
    for (let i = 0; i < ids.length; i++) {
      if (probs[i + 1] > this.threshold) boundaries.push(i);
    }
    if (final) {
      if (boundaries.length === 0 || boundaries[boundaries.length - 1] !== ids.length - 1) {
        boundaries.push(ids.length - 1);
      }
    } else {
      while (
        boundaries.length > 0 &&
        ids.length - 1 - boundaries[boundaries.length - 1] < this.lookaheadTokens
      ) {
        boundaries.pop();
      }
    }
    if (boundaries.length === 0) return { sentences: [], consumed: 0 };

    const sentences = [];
    let cursor = 0;
    for (const b of boundaries) {
      if (b < 0 || b >= offsets.length) continue;
      const end = final && b === ids.length - 1 ? text.length : offsets[b][1];
      if (!Number.isFinite(end) || end <= cursor) continue;
      const raw = text.slice(cursor, end);
      const trimmed = raw.trim();
      if (trimmed) sentences.push(trimmed);
      cursor = end;
    }
    return { sentences, consumed: cursor };
  }
}

export function languageProfile(lang) {
  const name = LANG_NAMES[lang];
  if (!name) throw new SubtitleError('segmentation', 'UNSUPPORTED_LANGUAGE', `不支持的语言: ${lang}`);
  return { name, code: lang };
}
