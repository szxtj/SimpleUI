import React, { useEffect, useState, useRef } from 'react';
import { Play, Pause, X, GripHorizontal, ArrowDownCircle, Trash2 } from 'lucide-react';

interface SubtitleRecord {
  en: string;
  zh: string;
}

export const SubtitleOverlay: React.FC = () => {
  const [isRunning, setIsRunning] = useState(true);
  const [allReady, setAllReady] = useState(false);
  const [missingModels, setMissingModels] = useState<string[]>([]);

  // 历史字幕记录列表（完整可滚动查看，包含每一句的原文与对应翻译）
  const [history, setHistory] = useState<SubtitleRecord[]>([]);

  // 当前说话中的实时流式切片，分成两段：
  //   stable  —— 已被「连续两次 ASR 一致」确认，不会再被改写
  //   pending —— 正在说、还会变的尾巴
  const [draft, setDraft] = useState<{ stable: string; pending: string }>({ stable: '', pending: '' });

  // 滚动容器与吸底状态控制
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isUserScrolledUpRef = useRef<boolean>(false);
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false);

  // 通知原生端面板已就绪
  useEffect(() => {
    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({ action: 'ready' });
    } catch {}
  }, []);

  // 监听并保持自动吸底滚动（新句子产生或流式出字时平滑下滚）
  useEffect(() => {
    if (!isUserScrolledUpRef.current && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [history, draft]);

  // 连接 SSE 服务端实时数据流
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: any = null;

    const connectSSE = () => {
      es = new EventSource('/api/subtitles/stream');

      es.addEventListener('status', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setIsRunning(data.running);
          setAllReady(Boolean(data.allReady));
          setMissingModels(data.missingModels || []);
          if (data.recent && Array.isArray(data.recent) && data.recent.length > 0) {
            setHistory((prev) => (prev.length === 0 ? data.recent.map((r: any) => ({ en: r.source_text, zh: r.target_text })) : prev));
          }
        } catch {}
      });

      // 实时流式增量：stable 段只增不减，pending 段随 ASR 修正而变
      es.addEventListener('draft', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setDraft({
            stable: typeof data.stable === 'string' ? data.stable : '',
            pending: typeof data.pending === 'string' ? data.pending : '',
          });
        } catch {}
      });

      // 标点断句触发整句定稿：完整句子产生并完成翻译，追加至历史列表
      es.addEventListener('finalized', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.source_text) {
            const newRec: SubtitleRecord = {
              en: data.source_text,
              zh: data.target_text || '',
            };
            setHistory((prev) => [...prev.slice(-99), newRec]);
          }
        } catch {}
      });

      es.onerror = () => {
        es?.close();
        reconnectTimer = setTimeout(connectSSE, 2000);
      };
    };

    connectSSE();

    return () => {
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  // 容器滚动监听：判断用户是否往上滚轮查阅历史
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 35;
    isUserScrolledUpRef.current = !isAtBottom;
    setShowScrollBottomBtn(!isAtBottom);
  };

  const scrollToBottom = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: 'smooth' });
      isUserScrolledUpRef.current = false;
      setShowScrollBottomBtn(false);
    }
  };

  // 窗口位置拖动（通过 WebKit IPC 发送绝对位移，100% 丝滑移动窗口）
  const handleMouseDownOnHeader = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    let lastX = e.screenX;
    let lastY = e.screenY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.screenX - lastX;
      const dy = moveEvent.screenY - lastY;
      lastX = moveEvent.screenX;
      lastY = moveEvent.screenY;
      try {
        (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({
          action: 'moveWindow',
          dx,
          dy,
        });
      } catch {}
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // 窗口右下角尺寸拉伸（通过 WebKit IPC 调整宽高）
  const handleMouseDownOnResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let lastX = e.screenX;
    let lastY = e.screenY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dw = moveEvent.screenX - lastX;
      const dh = moveEvent.screenY - lastY;
      lastX = moveEvent.screenX;
      lastY = moveEvent.screenY;
      try {
        (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({
          action: 'resizeWindow',
          dw,
          dh,
        });
      } catch {}
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // 关闭悬浮窗
  const handleClose = () => {
    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({ action: 'close' });
    } catch {
      window.close();
    }
  };

  // 清空当前字幕记录
  const handleClearHistory = async () => {
    setHistory([]);
    try {
      await fetch('/api/subtitles/clear', { method: 'POST' });
    } catch {}
  };

  // 切换监听状态
  const toggleListening = async () => {
    const action = isRunning ? 'stop' : 'start';
    try {
      const res = await fetch(`/api/subtitles/${action}`, { method: 'POST' });
      const data = await res.json();
      setIsRunning(data.running);
      try {
        (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({
          action: data.running ? 'startCapture' : 'stopCapture',
        });
      } catch {}
    } catch (e) {
      console.error('Toggle listening failed:', e);
    }
  };

  const readyCount = Math.max(0, 4 - missingModels.length);

  return (
    <div className="w-screen h-screen p-2 flex flex-col select-none bg-transparent font-sans antialiased box-border">
      <div
        className="relative w-full h-full rounded-2xl flex flex-col backdrop-blur-2xl bg-neutral-950/85 border border-white/10 shadow-[0_16px_40px_rgba(0,0,0,0.7)] text-white overflow-hidden transition-all duration-150"
      >
        {/* 顶部状态栏与拖动把手 */}
        <div
          onMouseDown={handleMouseDownOnHeader}
          className="flex items-center justify-between px-4 py-2 border-b border-white/10 text-xs cursor-move select-none shrink-0 bg-white/[0.02]"
        >
          {/* 左侧：拖拽把手与运行指示 */}
          <div className="flex items-center gap-2 text-neutral-400">
            <GripHorizontal className="w-3.5 h-3.5 opacity-50" />
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  !allReady
                    ? 'bg-amber-400'
                    : isRunning
                    ? 'bg-emerald-400 animate-pulse'
                    : 'bg-neutral-500'
                }`}
              />
              <span className="text-[11px] font-medium tracking-wide text-neutral-300">
                {!allReady
                  ? `模型准备中 (${readyCount}/4)`
                  : isRunning
                  ? '实时双语字幕 (系统内录)'
                  : '已暂停'}
              </span>
            </div>
          </div>

          {/* 右侧：极简控制按钮 */}
          <div className="flex items-center gap-1">
            {history.length > 0 && (
              <button
                onClick={handleClearHistory}
                title="清空字幕记录"
                className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            {allReady && (
              <button
                onClick={toggleListening}
                title={isRunning ? '暂停内录' : '继续内录'}
                className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              >
                {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
            )}

            <button
              onClick={handleClose}
              title="关闭字幕"
              className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 主内容区域：支持上下滚动查看所有历史字幕与当前说话流 */}
        {!allReady ? (
          <div className="flex-1 p-4 flex flex-col justify-center gap-2 text-xs">
            <div className="text-neutral-300 font-medium flex items-center gap-2">
              <span>离线语音识别模型尚未下载</span>
              <span className="text-neutral-500 text-[11px]">({missingModels.join(', ')})</span>
            </div>
            <div className="text-neutral-400 text-[11px] flex items-center gap-1.5">
              <span>在终端运行下载脚本：</span>
              <code className="bg-white/5 border border-white/10 px-2 py-0.5 rounded text-cyan-300 font-mono text-[11px] select-text">
                ./scripts/download_subtitle_models.sh --all
              </code>
            </div>
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 scroll-smooth scrollbar-thin scrollbar-thumb-white/10 hover:scrollbar-thumb-white/20 select-text"
          >
            {/* 历史字幕记录列表（自然折行，绝不截断） */}
            {history.map((item, idx) => (
              <div key={idx} className="flex flex-col gap-0.5 border-b border-white/5 pb-2.5 last:border-b-0">
                <div className="text-[14px] text-neutral-200 font-normal leading-relaxed break-words">
                  {item.en}
                </div>
                <div className="text-[13px] text-emerald-400 font-normal leading-relaxed break-words">
                  {item.zh}
                </div>
              </div>
            ))}

            {/* 当前正在说话中的流式切片：已确认段 + 正在说段 */}
            {(draft.stable || draft.pending) && (
              <div className="flex flex-col gap-1 py-1">
                <div className="text-[15px] font-medium tracking-normal leading-relaxed break-words">
                  <span className="text-white/95">{draft.stable}</span>
                  {draft.pending && (
                    <span className="text-cyan-300 font-semibold drop-shadow-[0_0_8px_rgba(34,211,238,0.75)]">
                      {draft.stable ? ' ' : ''}
                      {draft.pending}
                    </span>
                  )}
                  <span className="inline-block w-1.5 h-3.5 bg-cyan-400 rounded-[1px] ml-1 align-middle animate-pulse" />
                </div>
                <span className="text-neutral-500/80 text-[11px] italic">正在实时听写...</span>
              </div>
            )}

            {history.length === 0 && !draft.stable && !draft.pending && (
              <div className="h-full min-h-[60px] flex items-center justify-center text-neutral-500 text-xs italic select-none">
                {isRunning ? '等待系统音频播放中（视频、会议、播客等）...' : '内录已暂停'}
              </div>
            )}
          </div>
        )}

        {/* 悬浮回到底部快捷按钮（当用户手动上滑翻阅历史时出现） */}
        {showScrollBottomBtn && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 right-5 p-1.5 rounded-full bg-neutral-900/90 border border-white/20 text-neutral-300 hover:text-white hover:bg-neutral-800 shadow-lg transition-all cursor-pointer flex items-center gap-1 text-[11px] px-2.5"
          >
            <ArrowDownCircle className="w-3.5 h-3.5 text-cyan-400" />
            <span>回到底部</span>
          </button>
        )}

        {/* 右下角极简尺寸调整手柄 */}
        <div
          onMouseDown={handleMouseDownOnResize}
          className="absolute bottom-0.5 right-0.5 w-4 h-4 cursor-nwse-resize opacity-40 hover:opacity-100 flex items-end justify-end p-0.5 select-none"
          title="按住拖拽调节窗口尺寸"
        >
          <svg className="w-2.5 h-2.5 text-white/70" viewBox="0 0 6 6" fill="currentColor">
            <circle cx="5" cy="5" r="0.8" />
            <circle cx="5" cy="2.5" r="0.8" />
            <circle cx="2.5" cy="5" r="0.8" />
          </svg>
        </div>
      </div>
    </div>
  );
};
