// 单句翻译：Index-Translate-2B Q4_K_M via llama-server。
// 无上下文、无重试、无截断；任何异常直接 reject，由上层转 fatal。

import http from 'http';
import { SubtitleError } from './ml_helper.js';

const SOURCE_NAMES = { en: '英语', zh: '中文', ja: '日文' };
const TARGET_NAMES = { en: '英文', zh: '中文', ja: '日文' };

export class TranslationEngine {
  constructor({ port = 1249, timeoutMs = 15000 } = {}) {
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  translate(text, sourceLang, targetLang) {
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
    const prompt =
      `请将以下${sourceName}文本翻译为${targetName}，直接输出翻译结果，不要进行任何解释。\n\n` +
      source;
    const body = JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0,
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
            const content = choice?.message?.content;
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
            if (typeof content !== 'string' || !content.trim()) {
              reject(new SubtitleError('translation', 'TRANSLATION_EMPTY', '翻译结果为空'));
              return;
            }
            resolve(content.trim());
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
