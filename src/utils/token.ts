import { ChatMessage } from '../types/chat';

/**
 * Fast, accurate offline token estimator for chat messages.
 * In modern LLM tokenizers (BPE / SentencePiece like Gemma / Qwen / Llama):
 * - CJK characters are typically ~0.7 - 0.8 tokens each.
 * - Non-CJK characters (English words, numbers, punctuation) are ~3.8 - 4 characters per token.
 * - Delimiters / message framing boilerplate: ~4 tokens per message.
 */
/**
 * 会话级校准系数。
 *
 * 估算器是启发式的（实测：中文低估约 1/4、数字密集低估更多、英文长词高估），
 * 而 TTF 每轮都会返回**真实**的 `usage.prompt_tokens`。把「真实值 ÷ 同一批消息的原始估算值」
 * 记为系数，用于修正展示层数字，可自动适配任意分词器/模型，无需改公式。
 *
 * 注意：`estimateTextTokens` / `estimateHistoryTokens` 保持**纯函数**（不施加系数），
 * 系数只在展示层生效——否则「真实 ÷ 估算」会自我抵消，永远收敛不到真值。
 */
let calibrationFactor = 1;

/** 用一次真实测量更新系数（传入的是**未施加系数**的原始估算值） */
export function setTokenCalibration(realTokens: number, rawEstimatedTokens: number): void {
  if (!(realTokens > 0) || !(rawEstimatedTokens > 0)) return;
  const ratio = realTokens / rawEstimatedTokens;
  // 限幅，避免极端样本（超短提示、异常 usage）把系数带偏
  calibrationFactor = Math.min(2.5, Math.max(0.5, ratio));
}

export function getTokenCalibration(): number {
  return calibrationFactor;
}

/** 把原始估算值换算为校准后的展示值 */
export function applyTokenCalibration(tokens: number): number {
  return Math.max(0, Math.round(tokens * calibrationFactor));
}

export function estimateTextTokens(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  // Count CJK characters (Chinese, Japanese, Korean)
  const cjkMatches = trimmed.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLength = trimmed.length - cjkCount;

  const cjkTokens = Math.ceil(cjkCount * 0.75);
  const nonCjkTokens = Math.ceil(nonCjkLength / 3.8);

  return Math.max(1, cjkTokens + nonCjkTokens);
}

/**
 * Calculates the pure, persistent conversation history token count for a session.
 * Crucial rule: ONLY includes persistent user message text and assistant final answers.
 * Excludes single-turn RAG grounding prompt wrappers, thinking/reasoning_content,
 * and ephemeral system templates that are never sent in subsequent turns!
 */
export function estimateHistoryTokens(
  messages: Array<Partial<ChatMessage>>,
  systemPrompt?: string
): number {
  let total = 0;
  if (systemPrompt && systemPrompt.trim()) {
    total += estimateTextTokens(systemPrompt.trim()) + 4;
  }

  if (!messages || !Array.isArray(messages)) return total;

  for (const msg of messages) {
    if (!msg) continue;
    // Only user and assistant content form the persistent conversational history!
    if (msg.role === 'user' || msg.role === 'assistant') {
      const text = msg.content || '';
      total += estimateTextTokens(text) + 4;

      if (msg.images && msg.images.length > 0) {
        total += msg.images.length * 576; // standard vision token budget
      }
    }
  }

  return total;
}
