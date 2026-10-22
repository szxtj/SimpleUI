import { useMemo } from 'react';
import { splitSpeechSegments } from '../utils/speechText';
import { useSpeechAudio } from '../utils/speechStore';
import { SpeakButton } from './SpeakButton';
import { SpeechBar } from './SpeechBar';

/**
 * 主窗口与浮窗共用的朗读入口。
 *
 * 拆成两个薄组件（触发按钮 / 播放条）是因为它们在消息里的位置不同：按钮在操作行里，
 * 条子在消息最底部。两者都从 speechStore 取同一份状态，所以不需要把状态往上提。
 */

interface SpeechPartProps {
  messageId: string;
  content: string;
}

function useSpeechSegments(content: string) {
  return useMemo(() => splitSpeechSegments(content || ''), [content]);
}

/** 操作行里的喇叭按钮（触发语音合成的唯一入口） */
export function MessageSpeechTrigger({ messageId, content, title }: SpeechPartProps & { title?: string }) {
  const segments = useSpeechSegments(content);
  const speech = useSpeechAudio(messageId, segments);

  if (!segments.length) return null;

  return (
    <SpeakButton
      state={speech.state}
      onStart={speech.start}
      onCancel={speech.cancel}
      title={title}
    />
  );
}

/** 消息底部的进度 / 播放条（idle 时什么都不渲染） */
export function MessageSpeechBar({ messageId, content }: SpeechPartProps) {
  const segments = useSpeechSegments(content);
  const speech = useSpeechAudio(messageId, segments);

  if (speech.state.phase === 'idle') return null;

  return (
    <SpeechBar
      state={speech.state}
      onRegenerate={() => speech.start(false)}
      onDelete={speech.remove}
      onCancel={speech.cancel}
    />
  );
}
