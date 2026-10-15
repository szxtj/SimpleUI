import React, { useEffect, useState, useRef } from 'react';
import { Play, Pause, X, GripHorizontal, ArrowDownCircle, Trash2, Check, Loader2, FolderOpen } from 'lucide-react';
import { useI18n } from '../i18n';
import { SubtitleDownloadState } from '../types/chat';

interface SubtitleRecord {
  id: string;
  en: string;
  zh: string;
  status?: 'translating' | 'finalized';
}

export const SubtitleOverlay: React.FC = () => {
  const { t } = useI18n();
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [allReady, setAllReady] = useState(true);
  const [missingModels, setMissingModels] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loadingStage, setLoadingStage] = useState(0);
  const [downloadState, setDownloadState] = useState<SubtitleDownloadState | null>(null);

  // 上方历史字幕记录列表（完整可自由滚动阅览，包含每一句的原句与下方对应翻译）
  const [history, setHistory] = useState<SubtitleRecord[]>([]);

  // 下方正在实时流式吐字的当前句（160ms 极低延迟增量上屏）
  const [draft, setDraft] = useState<{ stable: string; pending: string }>({ stable: '', pending: '' });

  // 滚动容器与自由滚动/吸底状态控制
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isUserScrolledUpRef = useRef<boolean>(false);
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false);
  const prevAllReadyRef = useRef<boolean>(true);

  // 通知原生端面板已就绪
  useEffect(() => {
    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({ action: 'ready' });
    } catch {}
  }, []);

  // 当模型下载刚刚完成（allReady 从 false 变为 true）时，自动启动加载三级模型
  useEffect(() => {
    if (!prevAllReadyRef.current && allReady && !modelsLoaded && !isLoading) {
      fetch('/api/subtitles/start', { method: 'POST' }).catch(() => {});
    }
    prevAllReadyRef.current = allReady;
  }, [allReady, modelsLoaded, isLoading]);

  // 当三个模型全部加载完毕且处于运行状态时，自动通知原生端启动或停止 ScreenCaptureKit 音频内录
  useEffect(() => {
    try {
      if (modelsLoaded && isRunning && !isPaused) {
        (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({
          action: 'startCapture',
        });
      } else {
        (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({
          action: 'stopCapture',
        });
      }
    } catch {}
  }, [modelsLoaded, isRunning, isPaused]);

  // 监听并保持自动吸底滚动（用户未手动上滚查阅历史时，新句子上推或流式吐字自动平滑吸底）
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
          setIsRunning(Boolean(data.running));
          setIsPaused(Boolean(data.paused));
          setAllReady(Boolean(data.allReady));
          setMissingModels(data.missingModels || []);
          setIsLoading(Boolean(data.loading));
          setModelsLoaded(Boolean(data.modelsLoaded));
          setLoadingStage(typeof data.loadingStage === 'number' ? data.loadingStage : 0);
          if (data.downloadState) {
            setDownloadState(data.downloadState);
          }

          if (data.recent && Array.isArray(data.recent) && data.recent.length > 0) {
            setHistory((prev) =>
              prev.length === 0
                ? data.recent.map((r: any, idx: number) => ({
                    id: r.id || `hist_${idx}`,
                    en: r.source_text,
                    zh: r.target_text || '',
                    status: r.status || 'finalized',
                  }))
                : prev
            );
          }
        } catch {}
      });

      // 底部实时流式增量吐字
      es.addEventListener('draft', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setDraft({
            stable: typeof data.stable === 'string' ? data.stable : '',
            pending: typeof data.pending === 'string' ? data.pending : '',
          });
        } catch {}
      });

      // 句末或意群边界触发：第 0ms 乐观上推原句至上方，下方立即清空继续吐新词
      es.addEventListener('commit', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.source_text) {
            const newRec: SubtitleRecord = {
              id: data.id || `sub_${Date.now()}`,
              en: data.source_text,
              zh: data.target_text || '',
              status: data.target_text ? 'finalized' : 'translating',
            };
            setHistory((prev) => {
              if (prev.some((item) => item.id === newRec.id)) return prev;
              return [...prev.slice(-199), newRec];
            });
          }
        } catch {}
      });

      // 极速翻译完成回填：按 id 将中文译文填入刚刚推上去的原句下方
      const handleTranslated = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (!data.source_text) return;
          setHistory((prev) => {
            const idx = prev.findIndex((item) => item.id === data.id);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = {
                ...next[idx],
                en: data.source_text,
                zh: data.target_text || data.source_text,
                status: 'finalized',
              };
              return next;
            }
            return [
              ...prev.slice(-199),
              {
                id: data.id || `sub_${Date.now()}`,
                en: data.source_text,
                zh: data.target_text || data.source_text,
                status: 'finalized',
              },
            ];
          });
        } catch {}
      };

      es.addEventListener('translated', handleTranslated);
      es.addEventListener('finalized', handleTranslated);

      es.onerror = () => {
        es?.close();
        reconnectTimer = setTimeout(connectSSE, 1500);
      };
    };

    connectSSE();

    return () => {
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  // 容器滚动监听：判断用户是否往上滚轮自由查阅历史记录
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

  // 窗口位置拖动
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

  // 窗口右下角尺寸拉伸
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

  // 关闭悬浮窗（原生端将同时发送 stop 卸载全部三个模型）
  const handleClose = () => {
    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({ action: 'close' });
    } catch {
      fetch('/api/subtitles/stop', { method: 'POST' }).catch(() => {});
      window.close();
    }
  };

  // 清空当前字幕记录
  const handleClearHistory = async () => {
    setHistory([]);
    setDraft({ stable: '', pending: '' });
    try {
      await fetch('/api/subtitles/clear', { method: 'POST' });
    } catch {}
  };

  // 窗口内切换暂停/继续监听状态（不卸载模型，仅暂停内录）
  const toggleListening = async () => {
    const endpoint = isRunning ? 'pause' : 'resume';
    try {
      const res = await fetch(`/api/subtitles/${endpoint}`, { method: 'POST' });
      const data = await res.json();
      setIsRunning(Boolean(data.running));
      setIsPaused(Boolean(data.paused));
    } catch (e) {
      console.error('Toggle listening failed:', e);
    }
  };

  const handleStartDownload = async () => {
    try {
      await fetch('/api/subtitles/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'all' }),
      });
    } catch {}
  };

  const handleCancelDownload = async () => {
    try {
      await fetch('/api/subtitles/download/cancel', { method: 'POST' });
    } catch {}
  };

  const handleOpenModelsDir = async () => {
    try {
      await fetch('/api/subtitles/open-dir', { method: 'POST' });
    } catch {}
  };

  const readyDiskCount = Math.max(0, 3 - missingModels.length);
  const showLoadingScreen = allReady && (!modelsLoaded || isLoading);
  const activeStepDisplay = Math.min(3, loadingStage + 1);
  const progressPercent = modelsLoaded ? 100 : Math.min(92, Math.max(15, loadingStage * 33 + 22));

  const stages = [
    { key: 'vad', label: t('subtitleLoadingStageVad') },
    { key: 'asr', label: t('subtitleLoadingStageAsr') },
    { key: 'trans', label: t('subtitleLoadingStageTrans') },
  ];

  return (
    <div className="w-full h-full flex flex-col select-none bg-transparent font-sans antialiased box-border">
      <div className="relative w-full h-full rounded-[20px] flex flex-col bg-[#1b1c21]/95 text-white overflow-hidden">
        {/* 顶部状态栏与拖动把手 */}
        <div
          onMouseDown={handleMouseDownOnHeader}
          className="flex items-center justify-between px-4 py-2 border-b border-white/10 text-xs cursor-move select-none shrink-0 bg-white/[0.02]"
        >
          <div className="flex items-center gap-2 text-neutral-400">
            <GripHorizontal className="w-3.5 h-3.5 opacity-50" />
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  !allReady
                    ? 'bg-amber-400 animate-pulse'
                    : showLoadingScreen
                    ? 'bg-cyan-400 animate-pulse'
                    : isRunning
                    ? 'bg-emerald-400 animate-pulse'
                    : 'bg-neutral-500'
                }`}
              />
              <span className="text-[11px] font-medium tracking-wide text-neutral-300">
                {!allReady
                  ? downloadState?.active
                    ? `${t('subtitleStatusDownloading')} (${downloadState.progressPercent.toFixed(1)}%)`
                    : `${t('subtitlePreparingModels')} (${readyDiskCount}/3)`
                  : showLoadingScreen
                  ? `${t('subtitleLoadingModelsTitle')} (${activeStepDisplay}/3)`
                  : isRunning
                  ? t('subtitleRunningTitle')
                  : t('subtitlePaused')}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {modelsLoaded && history.length > 0 && (
              <button
                onClick={handleClearHistory}
                title={t('subtitleClearHistory')}
                className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            {allReady && modelsLoaded && !showLoadingScreen && (
              <button
                onClick={toggleListening}
                title={isRunning ? t('subtitlePauseCapture') : t('subtitleResumeCapture')}
                className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              >
                {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
            )}

            <button
              onClick={handleClose}
              title={t('subtitleClose')}
              className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 主内容区域：1. 磁盘缺模型与一键自动测速下载视图 / 2. 简约现代化三级模型加载进度视图 / 3. 双语流式字幕主视图 */}
        {!allReady ? (
          <div className="flex-1 px-5 py-3 flex flex-col justify-center gap-2.5 text-xs">
            <div className="text-neutral-200 font-medium flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate">{t('subtitleModelsNotReady')}</span>
                <span className="text-neutral-500 text-[11px] truncate">({missingModels.join(', ')})</span>
              </div>
            </div>

            {downloadState?.active ? (
              <div className="space-y-1.5 bg-white/[0.03] border border-white/10 rounded-xl p-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5 text-cyan-300 truncate">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    <span className="truncate">
                      {downloadState.phase === 'probing'
                        ? t('subtitleProbingSource')
                        : downloadState.phase === 'cleaning'
                        ? t('subtitleCleaningCache')
                        : downloadState.currentFile || downloadState.currentModelName}
                    </span>
                  </div>
                  <button
                    onClick={handleCancelDownload}
                    className="px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 text-[10px] shrink-0 cursor-pointer"
                  >
                    {t('subtitleCancelDownloadBtn')}
                  </button>
                </div>
                <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-200"
                    style={{ width: `${Math.max(3, Math.min(100, downloadState.progressPercent || 0))}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-neutral-400 font-mono">
                  <span>
                    {downloadState.selectedSource
                      ? `${downloadState.selectedSource.name} (${downloadState.selectedSource.latencyMs}ms)`
                      : ''}
                  </span>
                  <span>
                    {(downloadState.downloadedBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
                    {(downloadState.totalBytes / (1024 * 1024)).toFixed(1)} MB ·{' '}
                    {(downloadState.speedBps / (1024 * 1024)).toFixed(2)} MB/s
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="text-neutral-400 text-[11px]">{t('subtitleRunDownloadScript')}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleStartDownload}
                    className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-medium transition cursor-pointer"
                  >
                    {t('subtitleDownloadAllBtn')}
                  </button>
                  <button
                    onClick={handleOpenModelsDir}
                    className="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-neutral-300 text-[11px] flex items-center gap-1 transition cursor-pointer"
                  >
                    <FolderOpen className="w-3 h-3" />
                    <span>{t('subtitleOpenModelsDirBtn')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : showLoadingScreen ? (
          <div className="flex-1 px-6 py-4 flex flex-col items-center justify-center gap-3.5 select-none">
            {/* 现代极简进度条 */}
            <div className="w-full max-w-[520px] flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-neutral-300">
                <div className="flex items-center gap-2 font-medium">
                  <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                  <span>{t('subtitleLoadingModelsTitle')}</span>
                </div>
                <span className="text-[11px] font-mono text-cyan-300/90">
                  {activeStepDisplay} / 3
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-300 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* 三级模型阶段胶囊 */}
            <div className="w-full max-w-[520px] grid grid-cols-3 gap-2">
              {stages.map((st, idx) => {
                const isDone = loadingStage > idx;
                const isCurrent = loadingStage === idx;
                return (
                  <div
                    key={st.key}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] transition-all duration-200 ${
                      isDone
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                        : isCurrent
                        ? 'bg-cyan-500/10 border-cyan-400/35 text-cyan-200'
                        : 'bg-white/[0.02] border-white/[0.06] text-neutral-500'
                    }`}
                  >
                    {isDone ? (
                      <Check className="w-3 h-3 text-emerald-400 shrink-0" strokeWidth={2.5} />
                    ) : isCurrent ? (
                      <Loader2 className="w-3 h-3 text-cyan-400 animate-spin shrink-0" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-neutral-600 shrink-0 mx-0.5" />
                    )}
                    <span className="truncate">{st.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2.5 scroll-smooth scrollbar-thin scrollbar-thumb-white/10 hover:scrollbar-thumb-white/20 select-text"
          >
            {/* 上方已定稿历史列表：每句原文与中文译文上下成块排列，支持滚轮自由翻阅 */}
            {history.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-0.5 border-b border-white/[0.06] pb-2 last:border-b-0 transition-opacity duration-150"
              >
                <div className="text-[14px] text-neutral-100 font-normal leading-snug break-words">
                  {item.en}
                </div>
                {item.zh ? (
                  <div className="text-[13.5px] text-emerald-400 font-medium leading-snug break-words">
                    {item.zh}
                  </div>
                ) : (
                  <div className="text-[12px] text-cyan-400/70 italic animate-pulse">
                    {t('subtitleTranslating')}
                  </div>
                )}
              </div>
            ))}

            {/* 下方实时流式吐字区：随语音实时蹦词，成句瞬间推至上方并清空此处 */}
            {(draft.stable || draft.pending) && (
              <div className="flex flex-col gap-0.5 pt-1 border-t border-white/5">
                <div className="text-[15px] font-medium tracking-normal leading-relaxed break-words">
                  <span className="text-cyan-300">
                    {draft.stable}
                  </span>
                  {draft.pending && (
                    <span className="text-cyan-200/80">
                      {draft.stable ? ' ' : ''}
                      {draft.pending}
                    </span>
                  )}
                  <span className="inline-block w-1.5 h-3.5 bg-cyan-400 rounded-[1px] ml-1 align-middle animate-pulse" />
                </div>
              </div>
            )}

            {history.length === 0 && !draft.stable && !draft.pending && (
              <div className="h-full min-h-[60px] flex items-center justify-center text-neutral-500 text-xs italic select-none">
                {isRunning ? t('subtitleWaitingAudio') : t('subtitleCapturePaused')}
              </div>
            )}
          </div>
        )}

        {/* 悬浮回到底部快捷按钮（当用户手动向上滚轮翻阅历史时出现） */}
        {showScrollBottomBtn && modelsLoaded && !showLoadingScreen && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3.5 right-4 p-1.5 rounded-full bg-[#24262d] border border-white/20 text-neutral-200 hover:text-white hover:bg-[#2d3039] transition-all cursor-pointer flex items-center gap-1 text-[11px] px-2.5"
          >
            <ArrowDownCircle className="w-3.5 h-3.5 text-cyan-400" />
            <span>{t('subtitleScrollToBottom')}</span>
          </button>
        )}

        {/* 右下角极简尺寸调整手柄 */}
        <div
          onMouseDown={handleMouseDownOnResize}
          className="absolute bottom-1 right-1 w-4 h-4 cursor-nwse-resize opacity-40 hover:opacity-100 flex items-end justify-end p-0.5 select-none"
          title={t('subtitleResizeWindow')}
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
