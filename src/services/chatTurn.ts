// 单轮问答逻辑的唯一事实来源（Single Source of Truth）
//
// 设计约束：主窗口（App.tsx）与 Spotlight 浮窗（SpotlightView.tsx）**必须**共用
// 本模块里的全部问答逻辑——Grounding Prompt 文案、知识库检索门控、wire 消息构造、
// 会话级参数装配。历史上两处各内联了一份，已经漂移（提示词文案不一致），
// 这里统一收敛，避免再次分叉。
//
// 注意：本模块不做任何「上下文预算」判断。注入内容不再受 budgetChars 约束，
// 检索到多少就注入多少（由调用方的上下文窗口设置自行承载）。

import { WikiAPI } from './api';
import { AppSettings, ChatMessage, WikiCitation } from '../types/chat';
import { estimateHistoryTokens, applyTokenCalibration, CalibrationProvider } from '../utils/token';

export type RagLang = 'zh' | 'en';

/**
 * Grounding Prompt 文案（唯一来源）。
 * 采用主窗口版本：规则 1 给出「无关内容」的示例，规则 3 给出列举类示例。
 * 两窗口必须逐字一致。
 */
export function buildGroundingPrompt(
  promptContext: string,
  question: string,
  lang: RagLang
): string {
  if (lang === 'en') {
    return `[Encyclopedia Context]
Below are one or more encyclopedia articles (Infobox, lead section and relevant body sections) retrieved from an offline knowledge base for the user's question.

${promptContext}

[How to answer]
1. [Relevance filtering]: The context may contain material that is not related to the question (e.g. infobox fields, section headings, list entries). Locate the parts that actually answer the question and ignore the rest.
2. [Fact grounding]: Treat the facts, dates, people and numbers found there as your factual anchor. Combine them with your own knowledge when they are partial.
3. [Reproduce when asked]: If the user asks you to enumerate or list something (e.g. all works, all awards), reproduce the corresponding list from the context faithfully — do not shorten or omit items.
4. [Cite]: Mention which encyclopedia article(s) you used.

[User Question]
${question}`;
  }

  return `[百科原文参考]
以下是从离线知识库中检索到的与用户问题相关的百科条目内容（含基本档案、引言与相关小节）。

${promptContext}

[回答指引]
1. 【自行筛选】：上述原文中可能包含与问题无关的内容（例如档案中用不到的属性、其他小节、列表中的无关条目）。请自行定位其中真正与问题相关的部分，忽略其余。
2. 【事实锚定】：将其中出现的事实、时间、人物与数据作为真实性基石；若信息不完整，可结合你自身的知识补充展开。
3. 【按需照抄】：若用户要求列举类内容（例如"列出所有作品/所有奖项"），请忠实照抄原文中的对应列表，不要擅自删减或概括。
4. 【注明出处】：回答中请说明引用了哪篇百科条目。

[用户问题]
${question}`;
}

export interface WikiPromptResult {
  /** 实际发送给模型的用户消息内容（命中知识库时为 Grounding Prompt，否则为原始提问） */
  promptToSend: string;
  /** 命中知识库时的引用胶囊数据（原文 + 条目名） */
  citations: WikiCitation[];
}

/**
 * 知识库检索 + Grounding Prompt 包装（唯一入口，无预算约束）。
 *
 * 门控条件与两个窗口完全一致：服务总开关 && 会话级 📚 开关 && 服务已连接 && 有提问文本。
 * 任一环节拿不到结果即静默回退，返回原始提问且不注入任何内容。
 */
export async function buildPromptWithWiki(opts: {
  textToSend: string;
  lang: RagLang;
  wikiMasterEnabled: boolean;
  sessionEnableWiki: boolean;
  wikiConnected: boolean;
  isDeepSeek?: boolean;
  /** 用户点"停止"时的中止信号：会中止检索请求，并沿服务端管线中止所有相关模型调用 */
  signal?: AbortSignal;
}): Promise<WikiPromptResult> {
  const { textToSend, lang, wikiMasterEnabled, sessionEnableWiki, wikiConnected, isDeepSeek, signal } = opts;

  // 选用 DeepSeek 官方 API 时不使用知识库
  if (isDeepSeek || !(wikiMasterEnabled && sessionEnableWiki && wikiConnected && textToSend)) {
    return { promptToSend: textToSend, citations: [] };
  }

  try {
    const rag = await WikiAPI.getRagContext(textToSend, signal);
    if (rag.needsWiki && rag.citations && rag.citations.length > 0) {
      return {
        promptToSend: buildGroundingPrompt(rag.promptContext, textToSend, lang),
        citations: rag.citations,
      };
    }
  } catch (err) {
    // 用户中止必须向上传播，由调用方清理本轮占位消息
    if ((err as Error).name === 'AbortError' || signal?.aborted) throw err;
    console.warn('Knowledge Base retrieval error:', err);
  }

  return { promptToSend: textToSend, citations: [] };
}

/** 统一构造本轮的用户消息与助手占位消息（两窗口消息形状一致）。 */
export function buildTurnMessages(opts: {
  historyMessages: ChatMessage[];
  textToSend: string;
  images: string[];
  enableThinking: boolean;
  isDeepSeek?: boolean;
}): { userMessage: ChatMessage; assistantMessage: ChatMessage; nextMessages: ChatMessage[] } {
  // enableThinking 仍在 opts 中（调用方传入），但占位消息不再据此置 isThinking：
  // prefill 阶段不算思考中，首个思考 token 到达后由调用方置 true。
  const { historyMessages, textToSend, images, isDeepSeek } = opts;
  const now = Date.now();

  const userMessage: ChatMessage = {
    id: 'msg-user-' + now,
    role: 'user',
    content: textToSend,
    images: images.length > 0 ? images : undefined,
    timestamp: now,
  };

  const assistantMessage: ChatMessage = {
    id: 'msg-asst-' + (now + 1),
    role: 'assistant',
    content: '',
    reasoningContent: '',
    // prefill 阶段（尚未收到任何 token）不算"思考中"——否则思考动画会和
    // PrefillIndicator 同时显示。首个思考 token 到达后由调用方置 true。
    isThinking: false,
    // prefill 阶段标记：占位消息尚未收到任何 token。首个 token 到达时由
    // 调用方（App.tsx / SpotlightView.tsx 的 onFirstToken）置回 false。
    pending: true,
    // 回合阶段机：DeepSeek 模式直接进入 prefill；本地模式先进入知识库检索阶段
    stage: isDeepSeek ? 'prefill' : 'rag',
    prefillStartedAt: isDeepSeek ? now : undefined,
    timestamp: now + 1,
  };

  return {
    userMessage,
    assistantMessage,
    nextMessages: [...historyMessages, userMessage, assistantMessage],
  };
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

/**
 * 构造本轮实际发给推理引擎的 wire 消息数组：
 * 历史 + 用户消息（内容替换为含 Grounding Prompt 的 promptToSend）。
 * 支持滑动窗口安全防溢出修剪（多裁切保护前缀稳定与估算误差）。
 * 注意：持久化到会话历史里的用户消息内容始终是原始提问（textToSend），
 * Grounding Prompt 与修剪逻辑只存在于本次请求，绝不污染真实会话历史。
 */
export function buildWireMessages(
  historyMessages: ChatMessage[],
  userMessage: ChatMessage,
  promptToSend: string,
  opts?: SlidingWindowOptions
): ChatMessage[] {
  const currentTurnUser: ChatMessage = { ...userMessage, content: promptToSend };

  if (!opts?.maxContext) {
    return [...historyMessages, currentTurnUser];
  }

  const { systemPrompt, maxContext, maxTokens = 8192, provider = 'local' } = opts;
  const availablePromptBudget = Math.max(1024, maxContext - maxTokens);
  const triggerThreshold = Math.floor(availablePromptBudget * 0.85);
  const targetThreshold = Math.floor(availablePromptBudget * 0.70);

  let candidateHistory = [...historyMessages];
  let fullCandidate = [...candidateHistory, currentTurnUser];
  let currentTokens = applyTokenCalibration(
    estimateHistoryTokens(fullCandidate, systemPrompt, provider),
    provider
  );

  if (currentTokens <= triggerThreshold) {
    return fullCandidate;
  }

  // 触发滑动窗口：批量成对丢弃最早的历史对话轮次
  while (candidateHistory.length >= 2 && currentTokens > targetThreshold) {
    const removeCount = (candidateHistory[0]?.role === 'user' && candidateHistory[1]?.role === 'assistant') ? 2 : 1;
    candidateHistory = candidateHistory.slice(removeCount);
    fullCandidate = [...candidateHistory, currentTurnUser];
    currentTokens = applyTokenCalibration(
      estimateHistoryTokens(fullCandidate, systemPrompt, provider),
      provider
    );
  }

  return fullCandidate;
}

/** 会话级参数装配：把会话级的思考 / 知识库开关覆盖到全局设置上。 */
export function buildSessionSettings(
  settings: AppSettings,
  enableThinking: boolean,
  enableWikiSearch: boolean
): AppSettings {
  return { ...settings, enableThinking, enableWikiSearch };
}
