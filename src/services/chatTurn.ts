// 会话级参数装配 + 上下文窗口修剪（主窗口与 Spotlight 浮窗共用的问答辅助逻辑）。
//
// 注意：RAG 检索与 Grounding Prompt 文案已收敛到**服务端**（session_service /
// wiki_service —— 检索规划由当前 chat model 担任），本模块不再负责知识库门控；
// 消息构造也由服务端完成。这里只保留两窗口必须一致的装配与修剪逻辑。

import { AppSettings, ChatMessage } from '../types/chat';
import { estimateHistoryTokens, applyTokenCalibration, CalibrationProvider } from '../utils/token';

/** 会话级参数装配：把会话级的思考 / 知识库开关覆盖到全局设置上。 */
export function buildSessionSettings(
  settings: AppSettings,
  enableThinking: boolean,
  enableWikiSearch: boolean
): AppSettings {
  return { ...settings, enableThinking, enableWikiSearch };
}

export interface SlidingWindowOptions {
  systemPrompt?: string;
  maxContext?: number;
  maxTokens?: number;
  provider?: CalibrationProvider;
}

/**
 * 获取活跃上下文消息窗口（滑动窗口安全修剪）：
 * - 当上下文总用量接近上限时，按 (user, assistant) 成对批量回退修剪早期历史；
 * - 批量修剪至 70% 水位，多留出 30% 安全缓冲对抗分词误差，并避免每轮摩擦破坏 DeepSeek 缓存；
 * - 永久保留最新对话，System Prompt 无论如何不参与裁剪；
 * - 存储层保留完整历史，此函数仅用于计算发送给模型或展示层活跃的上下文窗口。
 */
export function getActiveContextMessages(
  messages: ChatMessage[],
  opts?: SlidingWindowOptions
): ChatMessage[] {
  if (!messages || messages.length <= 2 || !opts?.maxContext) {
    return messages;
  }

  const { systemPrompt, maxContext, maxTokens = 8192, provider = 'local' } = opts;
  const availablePromptBudget = Math.max(1024, maxContext - maxTokens);
  // 85% 预警触发线
  const triggerThreshold = Math.floor(availablePromptBudget * 0.85);
  // 70% 目标水位（多裁切一点：批量释放并保留前缀稳定）
  const targetThreshold = Math.floor(availablePromptBudget * 0.70);

  let candidate = [...messages];
  let currentTokens = applyTokenCalibration(
    estimateHistoryTokens(candidate, systemPrompt, provider),
    provider
  );

  if (currentTokens <= triggerThreshold) {
    return candidate;
  }

  // 必须成对 (user, assistant) 批量剔除最早的历史轮次
  while (candidate.length > 2 && currentTokens > targetThreshold) {
    const removeCount = (candidate[0]?.role === 'user' && candidate[1]?.role === 'assistant') ? 2 : 1;
    candidate = candidate.slice(removeCount);
    currentTokens = applyTokenCalibration(
      estimateHistoryTokens(candidate, systemPrompt, provider),
      provider
    );
  }

  return candidate;
}
