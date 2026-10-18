import { ChatMessage } from '../types/chat';

/**
 * 一轮问答（turn）的结构化视图。
 *
 * 这里只做**结构分组**（谁是这一轮的问题、谁是这一轮的最终回答），
 * 不复制消息正文、不做任何文本加工 —— 所有字段都是原消息对象的引用，
 * 因此每次流式 chunk 重建 turn 列表的代价是 O(消息数) 次指针比较。
 */
export interface ChatTurn {
  /** 稳定标识：该轮第一条消息的 id（通常就是用户提问的 id） */
  key: string;
  /** 在整段会话中的轮次下标（0 起） */
  index: number;
  /** 该轮的提问（会话可能以助手消息开头，此时为 undefined） */
  user?: ChatMessage;
  /** 该轮最后一条助手消息 —— 重试 / 删除这一轮的目标 */
  assistant?: ChatMessage;
  /** 该轮覆盖的消息区间（含两端），用于从原始 messages 里切出渲染所需的消息 */
  startMessageIndex: number;
  endMessageIndex: number;
}

/**
 * 把扁平消息列表切成轮次：
 * - 每条 user 消息开启新的一轮；
 * - 其后的 assistant 消息归属当前轮（多段回答时取最后一条作为该轮代表）；
 * - 会话若以 assistant 开头（历史数据），单独成一轮。
 */
export function buildTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const startsTurn = m.role === 'user' || current === null;

    if (startsTurn) {
      if (current) turns.push(current);
      current = {
        key: m.id,
        index: turns.length,
        user: m.role === 'user' ? m : undefined,
        assistant: m.role === 'assistant' ? m : undefined,
        startMessageIndex: i,
        endMessageIndex: i,
      };
    } else if (current) {
      current.endMessageIndex = i;
      if (m.role === 'assistant') current.assistant = m;
    }  }
  if (current) turns.push(current);
  return turns;
}

/**
 * 悬浮卡片用的纯文本预览。
 *
 * 只服务显示：去掉标题井号与代码围栏标记、把空白折叠成单空格，
 * 具体截断交给 CSS 的行数限制。绝不写回消息本体，也不改变任何渲染结果。
 */
export function toPreviewText(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
