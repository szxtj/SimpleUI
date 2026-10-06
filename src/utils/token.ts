import { ChatMessage } from '../types/chat';

/**
 * Fast, accurate offline token estimator for chat messages.
 * In modern LLM tokenizers (BPE / SentencePiece like Gemma / Qwen / Llama):
 * - CJK characters are typically ~0.7 - 0.8 tokens each.
 * - Non-CJK characters (English words, numbers, punctuation) are ~3.8 - 4 characters per token.
 * - Delimiters / message framing boilerplate: ~4 tokens per message.
 */
export type CalibrationProvider = 'local' | 'deepseek';

/**
 * 会话级校准系数（按 Provider 独立隔离存储，避免本地模型与 DeepSeek 分词器相互污染）。
 *
 * 估算器是启发式的，真实测量后把「真实值 ÷ 同一批消息的原始估算值」
 * 记为对应提供商的系数，用于修正展示层数字，自动适配各自的分词器。
 */
const calibrationFactors: Record<CalibrationProvider, number> = {
  local: 1.0,
  deepseek: 1.0,
};

/** 用一次真实测量更新对应 Provider 的系数（传入的是未施加系数的原始估算值） */
export function setTokenCalibration(
  realTokens: number,
  rawEstimatedTokens: number,
  provider: CalibrationProvider = 'local'
): void {
  if (!(realTokens > 0) || !(rawEstimatedTokens > 0)) return;
  const ratio = realTokens / rawEstimatedTokens;
  // 限幅，避免极端样本（超短提示、异常 usage）把系数带偏
  calibrationFactors[provider] = Math.min(2.5, Math.max(0.5, ratio));
}

export function getTokenCalibration(provider: CalibrationProvider = 'local'): number {
  return calibrationFactors[provider] || 1.0;
}

/** 把原始估算值换算为校准后的展示值 */
export function applyTokenCalibration(
  tokens: number,
  provider: CalibrationProvider = 'local'
): number {
  const factor = calibrationFactors[provider] || 1.0;
  return Math.max(0, Math.round(tokens * factor));
}

export function estimateTextTokens(
  text: string,
  provider: CalibrationProvider = 'local'
): number {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  // Count CJK characters (Chinese, Japanese, Korean)
  const cjkMatches = trimmed.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLength = trimmed.length - cjkCount;

  if (provider === 'deepseek') {
    // DeepSeek 采用 100K Byte-level BPE 分词器，中文二字词与常见词合并率高，约 0.6 tokens/字
    const cjkTokens = Math.ceil(cjkCount * 0.6);
    const nonCjkTokens = Math.ceil(nonCjkLength / 3.5);
    return Math.max(1, cjkTokens + nonCjkTokens);
  } else {
    // 本地引擎（如 Gemma 4 采用 256K SentencePiece），中文单字约 0.75 tokens/字
    const cjkTokens = Math.ceil(cjkCount * 0.75);
    const nonCjkTokens = Math.ceil(nonCjkLength / 3.8);
    return Math.max(1, cjkTokens + nonCjkTokens);
  }
}

/**
 * Calculates the pure, persistent conversation history token count for a session.
 * Crucial rule: ONLY includes persistent user message text and assistant final answers.
 * Excludes single-turn RAG grounding prompt wrappers, thinking/reasoning_content,
 * and ephemeral system templates that are never sent in subsequent turns!
 */
export function estimateHistoryTokens(
  messages: Array<Partial<ChatMessage>>,
  systemPrompt?: string,
  provider: CalibrationProvider = 'local'
): number {
  let total = 0;
  if (systemPrompt && systemPrompt.trim()) {
    total += estimateTextTokens(systemPrompt.trim(), provider) + 4;
  }

  if (!messages || !Array.isArray(messages)) return total;

  for (const msg of messages) {
    if (!msg) continue;
    // Only user and assistant content form the persistent conversational history!
    if (msg.role === 'user' || msg.role === 'assistant') {
      const text = msg.content || '';
      total += estimateTextTokens(text, provider) + 4;

      if (msg.images && msg.images.length > 0) {
        // DeepSeek 官方多模态动态瓦片切块，平均单图约 1,400 tokens；本地 SigLIP/Gemma 为 576 tokens
        const perImageTokens = provider === 'deepseek' ? 1400 : 576;
        total += msg.images.length * perImageTokens;
      }
    }
  }

  return total;
}
