import React, { useEffect, useLayoutEffect, useState, useRef, useMemo } from 'react';
import {
  Play,
  Pause,
  X,
  Trash2,
  Check,
  Loader2,
  FolderOpen,
  Globe,
  ChevronDown,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { SubtitleDownloadState } from '../types/chat';

interface SubtitleRecord {
  id: string;
  en: string;
  zh: string;
  status?: 'translating' | 'finalized';
}

type FontSizePreset = 'small' | 'medium' | 'large';

// 顶部控制栏 38px + 内容区上下内边距 22px = 60px；开启原文时双轨间距 8px -> 68px
const CHROME_HEIGHT_BOTH = 68;
const CHROME_HEIGHT_ZH_ONLY = 60;

const FONT_CONFIG: Record<
  FontSizePreset,
  {
    enFontSize: number;
    enLineHeight: number;
    zhFontSize: number;
    zhLineHeight: number;
  }
> = {
  small: {
    enFontSize: 15,
    enLineHeight: 22,
    zhFontSize: 16,
    zhLineHeight: 24,
  },
  medium: {
    enFontSize: 17.5,
    enLineHeight: 26,
    zhFontSize: 18.5,
    zhLineHeight: 28,
  },
  large: {
    enFontSize: 20,
    enLineHeight: 30,
    zhFontSize: 21,
    zhLineHeight: 32,
  },
};

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

  // 工具栏状态：是否显示英文原文、字体大小档位
  const [showOriginal, setShowOriginal] = useState<boolean>(true);
  const [fontSize, setFontSize] = useState<FontSizePreset>('medium');
  const [showFontMenu, setShowFontMenu] = useState<boolean>(false);

  // 严格一致的行数档位 N（2 表示 2+2 行，3 表示 3+3 行，4 表示 4+4 行...）
  const [linePairs, setLinePairs] = useState<number>(2);

  // 当前会话已定稿句子列表（每次新开窗口均自动清空）
  const [history, setHistory] = useState<SubtitleRecord[]>([]);

  // 正在实时流式吐字的当前句尾部
  const [draft, setDraft] = useState<{ stable: string; pending: string }>({
    stable: '',
    pending: '',
  });

  const enStreamRef = useRef<HTMLDivElement | null>(null);
  const zhStreamRef = useRef<HTMLDivElement | null>(null);
  const prevAllReadyRef = useRef<boolean>(true);

  const fontCfg = FONT_CONFIG[fontSize];
  const chromeHeight = showOriginal ? CHROME_HEIGHT_BOTH : CHROME_HEIGHT_ZH_ONLY;
  const pairHeight = showOriginal
    ? fontCfg.enLineHeight + fontCfg.zhLineHeight
    : fontCfg.zhLineHeight;

  // 注册原生面板回调：新开字幕窗口时立即清空旧历史，拖拽改变档位时同步 N+N 行数
  useEffect(() => {
    (window as any).onSubtitleOverlayShown = (initialPairs?: number) => {
      setHistory([]);
      setDraft({ stable: '', pending: '' });
      if (typeof initialPairs === 'number' && initialPairs >= 2) {
        setLinePairs(initialPairs);
      } else {
        setLinePairs(2);
      }
    };

    (window as any).onSubtitleLinePairsChanged = (nextPairs: number) => {
      if (typeof nextPairs === 'number' && nextPairs >= 2) {
        setLinePairs(nextPairs);
      }
    };

    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({ action: 'ready' });
    } catch {}

    return () => {
      delete (window as any).onSubtitleOverlayShown;
      delete (window as any).onSubtitleLinePairsChanged;
    };
  }, []);

  // 当切换字体大小、开关原文或模型加载完成进入字幕态时，通知原生端按当前档位 N (2+2, 3+3, 4+4) 自适应调节窗体高度
  useEffect(() => {
    if (!allReady || !modelsLoaded || isLoading) return;
    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({
        action: 'syncLayoutMetrics',
        chromeHeight,
        pairHeight,
        linePairs,
      });
    } catch {}
  }, [showOriginal, fontSize, allReady, modelsLoaded, isLoading, chromeHeight, pairHeight]);

  // 窗口宽度变化时保持双轨自动滚到底部最新行
  useEffect(() => {
    const handleResize = () => {
      if (enStreamRef.current) {
        enStreamRef.current.scrollTop = enStreamRef.current.scrollHeight;
      }
      if (zhStreamRef.current) {
        zhStreamRef.current.scrollTop = zhStreamRef.current.scrollHeight;
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 当模型下载刚刚完成（allReady 从 false 变为 true）时，自动启动加载两级模型
  useEffect(() => {
    if (!prevAllReadyRef.current && allReady && !modelsLoaded && !isLoading) {
      fetch('/api/subtitles/start', { method: 'POST' }).catch(() => {});
    }
    prevAllReadyRef.current = allReady;
  }, [allReady, modelsLoaded, isLoading]);

  // 当两个模型全部加载完毕且处于运行状态时，自动通知原生端启动或停止 ScreenCaptureKit 音频内录
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

  // 拼接连续英文流（已定稿句子 + 正在说的实时尾部无缝处于同一段落，commit 瞬间 0 跳变）
  const continuousEnText = useMemo(() => {
    const committedPart = history
      .slice(-60)
      .map((item) => item.en.trim())
      .filter(Boolean)
      .join(' ');
    const draftPart = [draft.stable, draft.pending].filter(Boolean).join(' ').trim();
    if (committedPart && draftPart) return `${committedPart} ${draftPart}`;
    return committedPart || draftPart;
  }, [history, draft.stable, draft.pending]);

  // 拼接连续中文流（按完整子句/句子以前句为上文参考翻译后依次往后堆叠，绝不闪烁或输出英文）
  const continuousZhText = useMemo(() => {
    return history
      .slice(-60)
      .filter((item) => Boolean(item.zh && item.zh.trim()))
      .map((item) => item.zh.trim())
      .join('');
  }, [history]);

  // 英文流更新或行数档位变化时滚至最新 N 行
  useLayoutEffect(() => {
    if (enStreamRef.current) {
      enStreamRef.current.scrollTop = enStreamRef.current.scrollHeight;
    }
  }, [continuousEnText, fontSize, showOriginal, linePairs]);

  // 中文流追加新译文或行数档位变化时滚至最新 N 行
  useLayoutEffect(() => {
    if (zhStreamRef.current) {
      zhStreamRef.current.scrollTop = zhStreamRef.current.scrollHeight;
    }
  }, [continuousZhText, fontSize, showOriginal, linePairs]);

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

          if (data.historyCount === 0) {
            setHistory([]);
          } else if (data.recent && Array.isArray(data.recent) && data.recent.length > 0) {
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

      // 会话重置/新开窗口清空事件
      es.addEventListener('clear', () => {
        setHistory([]);
        setDraft({ stable: '', pending: '' });
      });

      // 实时流式增量吐字
      es.addEventListener('draft', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setDraft({
            stable: typeof data.stable === 'string' ? data.stable : '',
            pending: typeof data.pending === 'string' ? data.pending : '',
          });
        } catch {}
      });

      // 句读/停止符触发：原句无感汇入 history
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

      // 上下文参考翻译完成回填：将中文直接往后追加到连续流末尾
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
                zh: data.target_text || '',
                status: 'finalized',
              };
              return next;
            }
            return [
              ...prev.slice(-199),
              {
                id: data.id || `sub_${Date.now()}`,
                en: data.source_text,
                zh: data.target_text || '',
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

  // 窗口位置拖动
  const handleMouseDownOnHeader = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('[data-no-drag]')) {
      return;
    }
    setShowFontMenu(false);
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

  // 窗口右下角尺寸拉伸（宽度平滑缩放，高度按 2+2、3+3、4+4... 行数档位自动吸附）
  const handleMouseDownOnResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let lastX = e.screenX;
    let lastY = e.screenY;

    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({
        action: 'resizeStart',
      });
    } catch {}

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

  // 关闭悬浮窗（原生端将同时发送 stop 卸载全部三个模型并清空历史）
  const handleClose = () => {
    setHistory([]);
    setDraft({ stable: '', pending: '' });
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

  // 窗口内切换暂停/继续监听状态
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

  const readyDiskCount = Math.max(0, 2 - missingModels.length);
  const showLoadingScreen = allReady && (!modelsLoaded || isLoading);
  const activeStepDisplay = Math.min(2, loadingStage + 1);
  const progressPercent = modelsLoaded ? 100 : Math.min(92, Math.max(20, loadingStage * 45 + 30));

  const stages = [
    { key: 'asr', label: t('subtitleLoadingStageAsr') },
    { key: 'trans', label: t('subtitleLoadingStageTrans') },
  ];

  const fontSizeLabel =
    fontSize === 'small'
      ? t('subtitleFontSmall')
      : fontSize === 'large'
      ? t('subtitleFontLarge')
      : t('subtitleFontMedium');

  const hasAnyContent = Boolean(continuousEnText || continuousZhText);

  return (
    <div
      className="w-full h-full flex flex-col select-none bg-transparent font-sans antialiased box-border"
      onClick={() => {
        if (showFontMenu) setShowFontMenu(false);
      }}
    >
      <div className="relative w-full h-full rounded-[16px] flex flex-col bg-[#222327]/95 text-white overflow-hidden border border-white/[0.08]">
        {/* 顶部控制栏（固定 38px 高度） */}
        <div
          onMouseDown={handleMouseDownOnHeader}
          className="h-[38px] flex items-center justify-between px-4 border-b border-white/[0.08] text-[12px] cursor-move select-none shrink-0"
        >
          {/* 左侧：翻译目标语言 / 关闭原文 / 字体大小 */}
          <div className="flex items-center gap-4 text-neutral-200">
            <div className="flex items-center gap-1.5 font-medium text-neutral-100">
              <Globe className="w-3.5 h-3.5 text-neutral-300" />
              <span>{t('subtitleTranslateToZh')}</span>
              <ChevronDown className="w-3 h-3 text-neutral-400" />
              <span
                title={
                  !allReady
                    ? `${t('subtitlePreparingModels')} (${readyDiskCount}/2)`
                    : showLoadingScreen
                    ? `${t('subtitleLoadingModelsTitle')} (${activeStepDisplay}/2)`
                    : isRunning
                    ? t('subtitleRunningTitle')
                    : t('subtitlePaused')
                }
                className={`w-1.5 h-1.5 rounded-full ml-0.5 ${
                  !allReady
                    ? 'bg-amber-400 animate-pulse'
                    : showLoadingScreen
                    ? 'bg-cyan-400 animate-pulse'
                    : isRunning
                    ? 'bg-emerald-400'
                    : 'bg-neutral-500'
                }`}
              />
            </div>

            {/* 关闭原文 / 开启原文 开关 */}
            <button
              type="button"
              onClick={() => setShowOriginal((prev) => !prev)}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/10 text-neutral-200 hover:text-white transition cursor-pointer"
            >
              <span className="relative inline-flex items-center justify-center px-1 py-[1px] text-[9px] font-bold leading-none rounded-[3px] border border-neutral-300/80 text-neutral-200">
                cc
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-[#222327] ${
                    showOriginal ? 'bg-emerald-400' : 'bg-neutral-500'
                  }`}
                />
              </span>
              <span>{showOriginal ? t('subtitleHideOriginal') : t('subtitleShowOriginal')}</span>
            </button>

            {/* Aa 字体大小下拉菜单 */}
            <div className="relative" data-no-drag>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFontMenu((prev) => !prev);
                }}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 text-neutral-200 hover:text-white transition cursor-pointer"
              >
                <span className="text-[12px] font-semibold tracking-tight">Aa</span>
                <span>{fontSizeLabel}</span>
                <ChevronDown className="w-3 h-3 text-neutral-400" />
              </button>

              {showFontMenu && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 top-full mt-1 w-28 rounded-lg bg-[#2b2d33] border border-white/15 py-1 shadow-xl z-50 text-[12px]"
                >
                  {(['small', 'medium', 'large'] as FontSizePreset[]).map((preset) => {
                    const label =
                      preset === 'small'
                        ? t('subtitleFontSmall')
                        : preset === 'large'
                        ? t('subtitleFontLarge')
                        : t('subtitleFontMedium');
                    const active = fontSize === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          setFontSize(preset);
                          setShowFontMenu(false);
                        }}
                        className={`w-full px-3 py-1 text-left flex items-center justify-between hover:bg-white/10 cursor-pointer ${
                          active ? 'text-emerald-400 font-medium' : 'text-neutral-200'
                        }`}
                      >
                        <span>{label}</span>
                        {active && <Check className="w-3 h-3" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 右侧：行数档位标签 / 清空 / 暂停 / 关闭 */}
          <div className="flex items-center gap-2">
            {allReady && modelsLoaded && !showLoadingScreen && (
              <span className="text-[10px] font-mono text-neutral-500 px-1 select-none">
                {showOriginal ? `${linePairs}+${linePairs}` : `${linePairs}L`}
              </span>
            )}

            {modelsLoaded && hasAnyContent && (
              <button
                type="button"
                onClick={handleClearHistory}
                title={t('subtitleClearHistory')}
                className="p-1 rounded hover:bg-white/10 text-neutral-400 hover:text-white transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            {allReady && modelsLoaded && !showLoadingScreen && (
              <button
                type="button"
                onClick={toggleListening}
                title={isRunning ? t('subtitlePauseCapture') : t('subtitleResumeCapture')}
                className="p-1 rounded hover:bg-white/10 text-neutral-400 hover:text-white transition cursor-pointer"
              >
                {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
            )}

            <button
              type="button"
              onClick={handleClose}
              title={t('subtitleClose')}
              className="w-5 h-5 rounded-full bg-white/15 hover:bg-white/25 text-neutral-200 hover:text-white flex items-center justify-center transition cursor-pointer ml-0.5"
            >
              <X className="w-3 h-3" strokeWidth={2.5} />
            </button>
          </div>
        </div>

        {/* 主内容区域 */}
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
          <div className="flex-1 px-6 py-3 flex flex-col items-center justify-center gap-3 select-none">
            <div className="w-full max-w-[520px] flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs text-neutral-300">
                <div className="flex items-center gap-2 font-medium">
                  <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                  <span>{t('subtitleLoadingModelsTitle')}</span>
                </div>
                <span className="text-[11px] font-mono text-cyan-300/90">
                  {activeStepDisplay} / 2
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-300 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            <div className="w-full max-w-[520px] grid grid-cols-2 gap-2">
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
          /* 严格等行双轨提词器流：原文 linePairs 行 + 译文 linePairs 行（2+2、3+3、4+4...），窗体高度由行高自适应决定 */
          <div className="flex-1 px-4 pt-[10px] pb-[12px] flex flex-col justify-between gap-[8px] overflow-hidden select-text">
            {!hasAnyContent ? (
              <div className="h-full flex items-center justify-center text-neutral-400/80 text-[13px] select-none">
                {isRunning ? t('subtitleWaitingAudio') : t('subtitleCapturePaused')}
              </div>
            ) : (
              <>
                {/* 上轨：linePairs 行英文连续流 */}
                {showOriginal && (
                  <div
                    ref={enStreamRef}
                    style={{
                      height: `${fontCfg.enLineHeight * linePairs}px`,
                      fontSize: `${fontCfg.enFontSize}px`,
                      lineHeight: `${fontCfg.enLineHeight}px`,
                    }}
                    className="w-full overflow-y-hidden font-semibold text-[#a6aab3] tracking-normal break-words scroll-smooth shrink-0"
                  >
                    {continuousEnText}
                  </div>
                )}

                {/* 下轨：linePairs 行中文连续流（与原文行数严格相等） */}
                <div
                  ref={zhStreamRef}
                  style={{
                    height: `${fontCfg.zhLineHeight * linePairs}px`,
                    fontSize: `${fontCfg.zhFontSize}px`,
                    lineHeight: `${fontCfg.zhLineHeight}px`,
                  }}
                  className="w-full overflow-y-hidden font-bold text-white tracking-wide break-words scroll-smooth shrink-0"
                >
                  {continuousZhText}
                </div>
              </>
            )}
          </div>
        )}

        {/* 右下角尺寸调整手柄 */}
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
