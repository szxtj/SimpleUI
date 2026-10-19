// 单句+滑动上下文翻译：Index-Translate-2B Q4_K_M via llama-server。
// 支持结合最近 2 句已完成翻译的上下文（基于 Index-Translate-2B 原生 instTrans 约束格式）消除指代不明与断句碎片感。

import http from 'http';
import { SubtitleError } from './ml_helper.js';

const SOURCE_NAMES = { en: '英语', zh: '中文', ja: '日文' };
const TARGET_NAMES = { en: '英文', zh: '中文', ja: '日文' };

function stripThinkBlock(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (out.includes('</think>')) {
    out = out.split('</think>').pop();
  }
  return out.replace(/^<think>/i, '').trim();
}

export class TranslationEngine {
  constructor({ port = 1249, timeoutMs = 15000 } = {}) {
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  translate(text, sourceLang, targetLang, contextRecords = []) {
    const source = String(text || '').trim();
    if (!source) return Promise.reject(new SubtitleError('translation', 'EMPTY_SOURCE', '空句子'));
    if (targetLang === 'none') return Promise.resolve('');
    const sourceName = SOURCE_NAMES[sourceLang];
    const targetName = TARGET_NAMES[targetLang];
    if (!sourceName || !targetName) {
      return Promise.reject(
        new SubtitleError('translation', 'UNSUPPORTED_LANGUAGE', `${sourceLang}->${targetLang}`)
      );
    }

    // 提取最近最多 2 句已完成翻译的上下文，利用 Index-Translate-2B 原生 instTrans 约束格式提升指代消解与口语连贯度
    const validContext = Array.isArray(contextRecords)
      ? contextRecords
          .filter((r) => r && r.source_text && r.target_text && r.status === 'finalized')
          .slice(-2)
      : [];

    let prompt;
    if (validContext.length > 0) {
      const ctxLines = validContext
        .map((r) => `${String(r.source_text).trim()} -> ${String(r.target_text).trim()}`)
        .join(' | ');
      prompt =
        `请将以下${sourceName}字幕翻译成${targetName}，并且严格遵循所有约束要求。\n` +
        `【源文】\n${source}\n` +
        `【约束要求】\n` +
        `1. 【注意】结合前文语境（${ctxLines}）保持人称指代、术语与口语语气自然连贯，仅翻译【源文】本身，严禁重复输出前文。\n` +
        `只输出译文，不要有任何额外说明。`;
    } else {
      prompt =
        `请将以下${sourceName}文本翻译为${targetName}，直接输出翻译结果，不要进行任何解释。\n\n` +
        source;
    }

    const body = JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(
                new SubtitleError(
                  'translation',
                  'TRANSLATION_HTTP_ERROR',
                  `翻译服务 HTTP ${res.statusCode}: ${data.slice(0, 300)}`
                )
              );
              return;
            }
            let json;
            try {
              json = JSON.parse(data);
            } catch {
              reject(
                new SubtitleError('translation', 'TRANSLATION_BAD_JSON', data.slice(0, 300))
              );
              return;
            }
            const choice = json.choices?.[0];
            const rawContent = choice?.message?.content;
            if (choice?.finish_reason !== 'stop') {
              reject(
                new SubtitleError(
                  'translation',
                  'TRANSLATION_TRUNCATED',
                  `finish_reason=${choice?.finish_reason ?? 'missing'}`
                )
              );
              return;
            }
            const cleaned = stripThinkBlock(rawContent);
            if (!cleaned) {
              reject(new SubtitleError('translation', 'TRANSLATION_EMPTY', '翻译结果为空'));
              return;
            }
            resolve(cleaned);
          });
        }
      );
      req.on('error', (err) =>
        reject(new SubtitleError('translation', 'TRANSLATION_REQUEST_FAILED', err.message))
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(new SubtitleError('translation', 'TRANSLATION_TIMEOUT', '翻译请求超时'));
      });
      req.write(body);
      req.end();
    });
  }
}
