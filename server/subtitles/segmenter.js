// SOTA 断句：XLM-R fast tokenizer (offset mapping) + SaT-3l-sm CoreML helper。
// 只用模型概率和 token 的字符 offset 切分，不做正则、不做词数 cap、不做 decode 回拼。

import { createRequire } from 'module';
import { SubtitleError } from './ml_helper.js';

const require = createRequire(import.meta.url);
const { Tokenizer } = require('tokenizers');

const LANG_NAMES = { en: '英语', zh: '中文', ja: '日文' };
const TRAILING_PUNCT_RE = /^[.?!。？！…，,、；;：:”"’')）\]】》]/;
const COMMA_END_RE = /[，,、；;：:]$/;

export class SatSegmenter {
  constructor({ tokenizerPath, helper, threshold = 0.5, lookaheadTokens = 10 }) {
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
   * final=false：保留最后一段，只提交距离末尾至少 lookaheadTokens 个 token 的边界，且在逗号处抑制短分句过切。
   * final=true：提交到文本末尾（包括最后一段）。
   */
  async split(draft, { final = false } = {}) {
    const text = String(draft || '');
    if (!text.trim()) return { sentences: [], consumed: 0 };
    if (!this.tokenizer) {
      throw new SubtitleError('segmentation', 'SAT_NOT_INITIALIZED', 'SaT tokenizer 未初始化');
    }
    const encoding = await this.tokenizer.encode(text, null, { addSpecialTokens: false });
    const allIds = encoding.getIds();
    const allOffsets = encoding.getOffsets();
    if (!Array.isArray(allIds) || allIds.length === 0) return { sentences: [], consumed: 0 };
    if (allOffsets.length !== allIds.length) {
      throw new SubtitleError('segmentation', 'SAT_OFFSET_COUNT', 'tokenizer offset 数量与 ids 不一致');
    }

    // 滑窗安全保护：若单次累积超过 510 tokens，截取前 510 tokens 推理并在窗口内保底切分，绝不因超长直接崩溃
    const windowOverflow = allIds.length > 510;
    const ids = windowOverflow ? allIds.slice(0, 510) : allIds;
    const offsets = windowOverflow ? allOffsets.slice(0, 510) : allOffsets;
    const effectiveFinal = Boolean(final) && !windowOverflow;

    const probs = await this.helper.segment(ids, { final: effectiveFinal });
    if (probs.length < ids.length + 1) {
      throw new SubtitleError('segmentation', 'SAT_BAD_PROBS', 'SaT 返回的概率长度不足');
    }

    // probs[0] 是 BOS，probs[i+1] 对应 ids[i]。
    const boundaries = [];
    for (let i = 0; i < ids.length; i++) {
      if (probs[i + 1] > this.threshold) boundaries.push(i);
    }
    if (effectiveFinal) {
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
      // 若窗口已满 (>510 tokens) 但模型未检出高于阈值的句界，选取窗口中后段概率峰值保底切分，防止草稿无限膨胀
      if (windowOverflow && boundaries.length === 0) {
        let bestIdx = Math.max(0, ids.length - 1 - this.lookaheadTokens);
        let bestProb = -1;
        const searchStart = Math.floor(ids.length * 0.35);
        const searchEnd = Math.max(searchStart, ids.length - 1 - this.lookaheadTokens);
        for (let i = searchStart; i <= searchEnd; i++) {
          if (probs[i + 1] > bestProb) {
            bestProb = probs[i + 1];
            bestIdx = i;
          }
        }
        boundaries.push(bestIdx);
      }
    }
    if (boundaries.length === 0) return { sentences: [], consumed: 0 };

    const sentences = [];
    let cursor = 0;
    for (const b of boundaries) {
      if (b < 0 || b >= offsets.length) continue;
      let end = effectiveFinal && b === ids.length - 1 ? text.length : offsets[b][1];
      if (!Number.isFinite(end) || end <= cursor) continue;

      // 吸收紧随边界 token 之后的句末标点或闭合引号/括号，防止标点被遗留在下一句草稿开头
      while (end < text.length && TRAILING_PUNCT_RE.test(text[end])) {
        end += 1;
      }

      const raw = text.slice(cursor, end);
      const trimmed = raw.trim();
      if (!trimmed) {
        cursor = end;
        continue;
      }

      // 流式非终态下：若候选切分点仅以逗号/分号结尾且分句较短、置信度未达高阈值(0.75)，继续等待完整句以提升翻译质量
      if (
        !effectiveFinal &&
        !windowOverflow &&
        COMMA_END_RE.test(trimmed) &&
        trimmed.length < 85 &&
        probs[b + 1] < 0.75
      ) {
        continue;
      }

      sentences.push(trimmed);
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
