import React, { useEffect, useRef, useState } from 'react';
import { Mic, Check, AlertCircle } from 'lucide-react';
import { useI18n } from '../i18n';

type VoiceState = 'idle' | 'recording' | 'transcribing' | 'done' | 'error';

interface VoicePayload {
  state: VoiceState;
  level?: number;
  text?: string;
  action?: 'insert' | 'paste';
}

declare global {
  interface Window {
    __setVoiceState?: (p: VoicePayload) => void;
  }
}

/**
 * 屏幕底部居中的语音识别胶囊（由原生 VoiceOverlayPanelController 承载）。
 *
 * 视觉参照设计稿：绿色渐变胶囊 + 中央白圈麦克风 + 两侧电平点阵。
 * 状态由原生侧经 `window.__setVoiceState` 下发：
 *   recording    长按右 ⌘ 录音中（点阵随实时音量起伏）
 *   transcribing 转写中（点阵匀速呼吸）
 *   done         完成（对勾 + 识别结果，区分「已输入」/「已粘贴」）
 *   error        失败（感叹号 + 原因）
 */
export const VoiceOverlay: React.FC = () => {
  const { t } = useI18n();
  const [state, setState] = useState<VoiceState>('idle');
  const [text, setText] = useState<string | undefined>(undefined);
  const [action, setAction] = useState<'insert' | 'paste' | undefined>(undefined);

  const levelRef = useRef(0);
  const stateRef = useRef<VoiceState>('idle');
  const dotsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    window.__setVoiceState = (p: VoicePayload) => {
      stateRef.current = p.state;
      setState(p.state);
      levelRef.current = p.level ?? 0;
      if (p.state === 'idle') {
        setText(undefined);
        setAction(undefined);
      } else {
        setText(p.text);
        setAction(p.action);
      }
    };
    // 通知原生：页面已挂载，可以下发状态（否则首批状态会丢失）
    try {
      (window as any).webkit?.messageHandlers?.voiceOverlay?.postMessage({ action: 'ready' });
    } catch {
      // 浏览器调试环境无原生桥，忽略
    }
    return () => {
      window.__setVoiceState = undefined;
    };
  }, []);

  // 电平点阵：用 rAF 直接改 DOM 样式，避免每帧 setState 触发重渲染
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const st = stateRef.current;
      const time = (now - t0) / 1000;
      dotsRef.current.forEach((el, i) => {
        if (!el) return;
        if (st === 'recording') {
          // 越靠中间越亮，叠加声压与时间波动
          const centrality = 1 - Math.abs(i - 3.5) / 3.5;
          const wave = 0.5 + 0.5 * Math.sin(time * 5.5 + i * 0.85);
          const e = Math.min(1, 0.16 + centrality * 0.3 + levelRef.current * (0.55 + 0.45 * wave));
          el.style.opacity = String(0.22 + e * 0.78);
          el.style.transform = `scale(${0.7 + e * 0.75})`;
        } else if (st === 'transcribing') {
          const e = 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(time * 4 - i * 0.7));
          el.style.opacity = String(0.22 + e * 0.6);
          el.style.transform = `scale(${0.75 + e * 0.5})`;
        } else {
          el.style.opacity = '0.26';
          el.style.transform = 'scale(0.78)';
        }
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (state === 'idle') {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  const renderDots = (from: number) =>
    [0, 1, 2, 3].map((k) => {
      const i = from + k;
      return (
        <span
          key={i}
          ref={(el) => {
            dotsRef.current[i] = el;
          }}
          className="block rounded-full bg-white"
          style={{ width: 4, height: 4, opacity: 0.26, transform: 'scale(0.78)' }}
        />
      );
    });

  const icon =
    state === 'done' ? (
      <Check className="w-[14px] h-[14px] text-white" strokeWidth={2.6} />
    ) : state === 'error' ? (
      <AlertCircle className="w-[14px] h-[14px] text-white" strokeWidth={2.4} />
    ) : (
      <Mic className="w-[14px] h-[14px] text-white" strokeWidth={2.2} />
    );

  // 落点只有两种：本 App 内插入（insert）/ 其它 App 粘贴（paste）
  const actionLabel = action === 'paste' ? t('voicePasted') : t('voiceInserted');

  // 录音中实时预览：如果文本超出单行容量（约 50 字），前置省略号并展示最新的后半句，让用户实时看到最新的识别字词
  const livePreviewText =
    state === 'recording' && text
      ? text.length > 50
        ? `…${text.slice(-48)}`
        : text
      : undefined;

  const caption =
    state === 'error'
      ? text
      : state === 'done' && text
      ? `${actionLabel}：${text}`
      : state === 'transcribing'
      ? (text ? `${t('voiceTranscribing')} ${text.length > 45 ? `…${text.slice(-42)}` : text}` : t('voiceTranscribing'))
      : livePreviewText;

  return (
    <div className="relative h-screen w-screen bg-transparent flex flex-col items-center pt-2.5 overflow-visible select-none">
      <div
        className={`relative flex items-center gap-2 h-[44px] px-3 rounded-full flex-shrink-0 ${state === 'recording' ? 'animate-[voicePulse_1.6s_ease-in-out_infinite]' : ''}`}
        style={{
          background: 'linear-gradient(158deg, #7ad99b 0%, #4dbd7c 48%, #35a468 100%)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -2px 6px rgba(0,0,0,0.12)',
          border: '1px solid rgba(255,255,255,0.25)',
        }}
      >
        <div className="flex items-center gap-[4px]">{renderDots(0)}</div>
        <div className="mx-1.5 flex items-center justify-center w-7 h-7 rounded-full border-[1.2px] border-white/80 flex-shrink-0">
          {icon}
        </div>
        <div className="flex items-center gap-[4px]">{renderDots(4)}</div>

        {/* 结果小框直接在球下方绝对定位浮现，宽度拉宽至 540px，避免过早截断出现省略号 */}
        {caption && (
          <div className="absolute top-[calc(100%+6px)] left-1/2 -translate-x-1/2 max-w-[540px] whitespace-nowrap overflow-hidden text-ellipsis rounded-lg px-3 py-1 text-[11px] leading-snug bg-white/95 text-zinc-800 border border-black/10 dark:bg-[#2a2c33] dark:text-zinc-50 dark:border-white/15 shadow-md shadow-black/15 dark:shadow-black/35 backdrop-blur z-10 pointer-events-none transition-all duration-150">
            {caption}
          </div>
        )}
      </div>
    </div>
  );
};
