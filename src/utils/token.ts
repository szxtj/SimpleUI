import { ChatMessage } from '../types/chat';

/**
 * Fast, accurate offline token estimator for chat messages.
 * In modern LLM tokenizers (BPE / SentencePiece like Gemma / Qwen / Llama):
 * - CJK characters are typically ~0.7 - 0.8 tokens each.
 * - Non-CJK characters (English words, numbers, punctuation) are ~3.8 - 4 characters per token.
 * - Delimiters / message framing boilerplate: ~4 tokens per message.
 */
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
