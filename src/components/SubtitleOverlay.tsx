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
  Volume2,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { SubtitleDownloadState } from '../types/chat';

interface SubtitleRecord {
  id: string;
  source_text: string;
  target_text: string;
  status: 'pending' | 'finalized';
}

interface SubtitleFatalError {
  stage: string;
  code: string;
  message: string;
  detail?: string | null;
}

type FontSizePreset = 'small' | 'medium' | 'large';

// 顶部控制栏 38px + 内容区上下内边距 22px = 60px；开启原文时双轨间距 8px -> 68px
const CHROME_HEIGHT_BOTH = 68;
const CHROME_HEIGHT_ZH_ONLY = 60;

/// 选项带上的两位缩写（完整文案放在 title 里）
const LANG_CHIP_LABEL: Record<string, string> = { none: 'NO', zh: 'CN', en: 'EN', ja: 'JP' };

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

  // 工具栏状态：是否显示原文、字体大小档位、声音源语言、翻译目标语言
  const [showOriginal, setShowOriginal] = useState<boolean>(true);
  const [fontSize, setFontSize] = useState<FontSizePreset>('medium');
  const [showFontMenu, setShowFontMenu] = useState<boolean>(false);
  const [sourceLang, setSourceLang] = useState<'en' | 'zh'>('en');
  const [targetLang, setTargetLang] = useState<'none' | 'zh' | 'ja' | 'en'>('zh');
  const [showSourceMenu, setShowSourceMenu] = useState<boolean>(false);
  const [showTargetMenu, setShowTargetMenu] = useState<boolean>(false);

  // 窄面板（最小宽度 520px）下工具栏文案会折行溢出栏高：只留图标 + 下拉箭头，值放进 tooltip。
  const [compactBar, setCompactBar] = useState<boolean>(() => window.innerWidth < 760);
  useEffect(() => {
    const onResize = () => setCompactBar(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 严格一致的行数档位 N（2 表示 2+2 行，3 表示 3+3 行，4 表示 4+4 行...）
  const [linePairs, setLinePairs] = useState<number>(2);

  // 原文只追加，不重组；译文按完整句追加
  const [sourceText, setSourceText] = useState('');
  const [targetRecords, setTargetRecords] = useState<SubtitleRecord[]>([]);
  const [fatalError, setFatalError] = useState<SubtitleFatalError | null>(null);

  const enStreamRef = useRef<HTMLDivElement | null>(null);
  const zhStreamRef = useRef<HTMLDivElement | null>(null);
  const prevAllReadyRef = useRef<boolean>(true);

  const fontCfg = FONT_CONFIG[fontSize];
  const isNone = targetLang === 'none';
  const isSingleTrack = isNone || !showOriginal;
  const chromeHeight = isSingleTrack ? CHROME_HEIGHT_ZH_ONLY : CHROME_HEIGHT_BOTH;
  const singleTrackLineHeight = sourceLang === 'zh' ? fontCfg.zhLineHeight : fontCfg.enLineHeight;
  const pairHeight = isSingleTrack
    ? (isNone ? singleTrackLineHeight : fontCfg.zhLineHeight)
    : fontCfg.enLineHeight + fontCfg.zhLineHeight;

  const openMenu: 'source' | 'target' | 'font' | null = showSourceMenu
    ? 'source'
    : showTargetMenu
    ? 'target'
    : showFontMenu
    ? 'font'
    : null;

  // 注册原生面板回调：新开字幕窗口时立即清空旧历史，拖拽改变档位时同步 N+N 行数
  useEffect(() => {
    (window as any).onSubtitleOverlayShown = (initialPairs?: number) => {
      setSourceText('');
      setTargetRecords([]);
      setFatalError(null);
      // 窗口重新打开时不保留任何下拉（否则菜单会挂在新窗口外面）
      setShowFontMenu(false);
      setShowSourceMenu(false);
      setShowTargetMenu(false);
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

    (window as any).onSubtitleFatalError = (payload: SubtitleFatalError) => {
      setFatalError(payload || { stage: 'native', code: 'UNKNOWN', message: '字幕链路错误' });
      setIsRunning(false);
      setModelsLoaded(false);
    };

    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({ action: 'ready' });
    } catch {}

    return () => {
      delete (window as any).onSubtitleOverlayShown;
      delete (window as any).onSubtitleLinePairsChanged;
      delete (window as any).onSubtitleFatalError;
    };
  }, []);

  // 当切换字体大小、开关原文、切换声音源/翻译目标或模型加载完成进入字幕态时，通知原生端按当前档位 N 自适应调节窗体高度
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
  }, [showOriginal, fontSize, targetLang, sourceLang, allReady, modelsLoaded, isLoading, chromeHeight, pairHeight, linePairs]);

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

  // 原文是单一追加流：服务端每来一个 delta 就追加，不在提交句子时重组。
  const continuousSourceText = sourceText;

  // 译文只拼接已 finalized 的完整句；pending 单独提示，不提前显示半句译文。
  const continuousTargetText = useMemo(() => {
    if (targetLang === 'none') return '';
    const separator = targetLang === 'en' ? ' ' : '';
    return targetRecords
      .filter((item) => item.status === 'finalized' && item.target_text.trim())
      .map((item) => item.target_text.trim())
      .join(separator);
  }, [targetRecords, targetLang]);

  const hasPendingTarget = useMemo(
    () => targetLang !== 'none' && targetRecords.some((item) => item.status === 'pending'),
    [targetRecords, targetLang]
  );

  // 源文流更新或行数档位变化时滚至最新 N 行
  useLayoutEffect(() => {
    if (enStreamRef.current) {
      enStreamRef.current.scrollTop = enStreamRef.current.scrollHeight;
    }
  }, [continuousSourceText, fontSize, showOriginal, linePairs, targetLang, sourceLang]);

  // 译文流追加新译文或行数档位变化时滚至最新 N 行
  useLayoutEffect(() => {
    if (zhStreamRef.current) {
      zhStreamRef.current.scrollTop = zhStreamRef.current.scrollHeight;
    }
  }, [continuousTargetText, fontSize, showOriginal, linePairs, targetLang]);

  // 连接 SSE 服务端实时数据流：原文只追加，译文按句更新；断开直接 fatal，不自动重连。
  useEffect(() => {
    const es = new EventSource('/api/subtitles/stream');

    const applyStatus = (data: any) => {
      setIsRunning(Boolean(data.running));
      setIsPaused(Boolean(data.paused));
      setAllReady(Boolean(data.allReady));
      setMissingModels(data.missingModels || []);
      setIsLoading(Boolean(data.loading));
      setModelsLoaded(Boolean(data.modelsLoaded));
      setLoadingStage(typeof data.loadingStage === 'number' ? data.loadingStage : 0);
      if (data.downloadState) setDownloadState(data.downloadState);
      if (data.sourceLang === 'en' || data.sourceLang === 'zh') setSourceLang(data.sourceLang);
      if (
        data.targetLang === 'none' ||
        data.targetLang === 'zh' ||
        data.targetLang === 'ja' ||
        data.targetLang === 'en'
      ) {
        setTargetLang(data.targetLang);
      }
      if ('fatalError' in data) setFatalError(data.fatalError || null);
    };

    es.addEventListener('status', (e: MessageEvent) => {
      try {
        applyStatus(JSON.parse(e.data));
      } catch {
        setFatalError({ stage: 'stream', code: 'BAD_STATUS', message: '状态事件解析失败' });
      }
    });

    es.addEventListener('snapshot', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status) applyStatus(data.status);
        if (typeof data.sourceText === 'string') setSourceText(data.sourceText);
        if (Array.isArray(data.targetRecords)) {
          setTargetRecords(
            data.targetRecords.map((r: any) => ({
              id: String(r.id),
              source_text: String(r.source_text || ''),
              target_text: String(r.target_text || ''),
              status: r.status === 'finalized' ? 'finalized' : 'pending',
            }))
          );
        }
      } catch {
        setFatalError({ stage: 'stream', code: 'BAD_SNAPSHOT', message: '快照事件解析失败' });
      }
    });

    es.addEventListener('source_delta', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.text === 'string' && data.text) {
          setSourceText((prev) => {
            const next = prev + data.text;
            return next.length > 200000 ? next.slice(-200000) : next;
          });
        }
      } catch {
        setFatalError({ stage: 'stream', code: 'BAD_SOURCE_DELTA', message: '原文增量解析失败' });
      }
    });

    es.addEventListener('commit', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const r = data.record;
        if (!r || !r.id) {
          setFatalError({ stage: 'stream', code: 'BAD_COMMIT', message: '提交事件缺少 record' });
          return;
        }
        const rec: SubtitleRecord = {
          id: String(r.id),
          source_text: String(r.source_text || ''),
          target_text: String(r.target_text || ''),
          status: r.status === 'finalized' ? 'finalized' : 'pending',
        };
        setTargetRecords((prev) => {
          if (prev.some((x) => x.id === rec.id)) {
            setFatalError({ stage: 'stream', code: 'DUPLICATE_COMMIT', message: `重复句子: ${rec.id}` });
            return prev;
          }
          return [...prev.slice(-199), rec];
        });
      } catch {
        setFatalError({ stage: 'stream', code: 'BAD_COMMIT', message: '提交事件解析失败' });
      }
    });

    es.addEventListener('translation', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const r = data.record;
        if (!r || !r.id) {
          setFatalError({ stage: 'stream', code: 'BAD_TRANSLATION', message: '翻译事件缺少 record' });
          return;
        }
        setTargetRecords((prev) => {
          const idx = prev.findIndex((x) => x.id === r.id);
          if (idx === -1) {
            setFatalError({ stage: 'stream', code: 'UNKNOWN_RECORD', message: `未知句子: ${r.id}` });
            return prev;
          }
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            target_text: String(r.target_text || ''),
            status: r.status === 'finalized' ? 'finalized' : next[idx].status,
          };
          return next;
        });
      } catch {
        setFatalError({ stage: 'stream', code: 'BAD_TRANSLATION', message: '翻译事件解析失败' });
      }
    });

    es.addEventListener('fatal', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setFatalError({
          stage: String(data.stage || 'unknown'),
          code: String(data.code || 'UNKNOWN'),
          message: String(data.message || '字幕链路错误'),
          detail: data.detail ?? null,
        });
      } catch {
        setFatalError({ stage: 'stream', code: 'FATAL_EVENT_BAD', message: '致命错误事件解析失败' });
      }
      setIsRunning(false);
      setModelsLoaded(false);
      es.close();
    });

    es.addEventListener('clear', () => {
      setSourceText('');
      setTargetRecords([]);
      setFatalError(null);
    });

    es.onerror = () => {
      setFatalError({
        stage: 'stream',
        code: 'SSE_DISCONNECTED',
        message: '字幕事件流已断开，已停止采集；请关闭字幕窗口后重试',
      });
      setIsRunning(false);
      setModelsLoaded(false);
      es.close();
    };

    return () => es.close();
  }, []);

  const handleSelectSourceLang = async (lang: 'en' | 'zh') => {
    if (lang === sourceLang) {
      setShowSourceMenu(false);
      return;
    }
    setSourceLang(lang);
    setShowSourceMenu(false);
    let nextTarget = targetLang;
    // 同语言不翻译：若切换后 sourceLang === targetLang，目标语言自动切换到 'none'
    if (targetLang === lang) {
      nextTarget = 'none';
      setTargetLang('none');
      setShowOriginal(true);
    }
    setSourceText('');
    setTargetRecords([]);
    setFatalError(null);
    try {
      await fetch('/api/subtitles/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceLang: lang, targetLang: nextTarget }),
      });
    } catch (e) {
      console.error('Failed to update subtitle sourceLang:', e);
    }
  };

  const handleSelectTargetLang = async (lang: 'none' | 'zh' | 'ja' | 'en') => {
    setTargetLang(lang);
    setShowTargetMenu(false);
    setSourceText('');
    setTargetRecords([]);
    setFatalError(null);
    if (lang === 'none') {
      setShowOriginal(true);
    }
    try {
      await fetch('/api/subtitles/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLang: lang }),
      });
    } catch (e) {
      console.error('Failed to update subtitle targetLang:', e);
    }
  };

  // 窗口位置拖动
  const handleMouseDownOnHeader = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('[data-no-drag]')) {
      return;
    }
    setShowFontMenu(false);
    setShowSourceMenu(false);
    setShowTargetMenu(false);
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
    setSourceText('');
    setTargetRecords([]);
    setFatalError(null);
    try {
      (window as any).webkit?.messageHandlers?.subtitleOverlay?.postMessage({ action: 'close' });
    } catch {
      fetch('/api/subtitles/stop', { method: 'POST' }).catch(() => {});
      window.close();
    }
  };

  // 清空当前字幕记录
  const handleClearHistory = async () => {
    setSourceText('');
    setTargetRecords([]);
    setFatalError(null);
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

  const readyDiskCount = Math.max(0, 3 - missingModels.length);
  const showLoadingScreen = allReady && (!modelsLoaded || isLoading);
  const activeStepDisplay = Math.min(3, loadingStage + 1);
  const progressPercent = modelsLoaded ? 100 : Math.min(92, Math.max(20, loadingStage * 30 + 30));

  const stages = [
    { key: 'asr', label: t('subtitleLoadingStageAsr') },
    { key: 'ml', label: t('subtitleLoadingStageMl') },
    { key: 'trans', label: t('subtitleLoadingStageTrans') },
  ];

  const sourceOptions: Array<{ id: 'en' | 'zh'; label: string }> = [
    { id: 'en', label: t('subtitleLangEn') },
    { id: 'zh', label: t('subtitleLangZh') },
  ];

  const allTargetLanguages: Array<{
    id: 'zh' | 'en' | 'ja';
    labelKey: 'subtitleLangZh' | 'subtitleLangEn' | 'subtitleLangJa';
  }> = [
    { id: 'zh', labelKey: 'subtitleLangZh' },
    { id: 'en', labelKey: 'subtitleLangEn' },
    { id: 'ja', labelKey: 'subtitleLangJa' },
  ];

  const targetOptions = [
    { id: 'none' as const, label: t('subtitleLangNone') },
    ...allTargetLanguages
      .filter((l) => l.id !== sourceLang)
      .map((l) => ({ id: l.id, label: t(l.labelKey) })),
  ];

  const fontSizeLabel =
    fontSize === 'small'
      ? t('subtitleFontSmall')
      : fontSize === 'large'
      ? t('subtitleFontLarge')
      : t('subtitleFontMedium');

  const targetLabel =
    targetLang === 'none'
      ? t('subtitleTranslateNone')
      : targetLang === 'zh'
      ? t('subtitleTranslateToZh')
      : targetLang === 'ja'
      ? t('subtitleTranslateToJa')
      : t('subtitleTranslateToEn');

  const hasAnyContent = Boolean(continuousSourceText || continuousTargetText);

  // 横向选项带：三个控件共用同一条带子，用两位缩写把宽度压进一行。
  // 带子贴在工具栏下方、盖住字幕区顶部，带下沿的投影压住下面的内容 ——
  // 它永远落在卡片内部，所以既不会被窗口下沿裁掉，也不需要改窗口高度（不会有抖动）。
  const optionChips: Array<{ key: string; label: string; title: string; active: boolean; onSelect: () => void }> =
    openMenu === 'source'
      ? sourceOptions.map((opt) => ({
          key: opt.id,
          label: LANG_CHIP_LABEL[opt.id],
          title: opt.label,
          active: sourceLang === opt.id,
          onSelect: () => handleSelectSourceLang(opt.id),
        }))
      : openMenu === 'target'
      ? targetOptions.map((opt) => ({
          key: String(opt.id),
          label: LANG_CHIP_LABEL[opt.id],
          title: opt.label,
          active: targetLang === opt.id,
          onSelect: () => handleSelectTargetLang(opt.id as 'none' | 'zh' | 'ja' | 'en'),
        }))
      : openMenu === 'font'
      ? (['small', 'medium', 'large'] as FontSizePreset[]).map((preset) => ({
          key: preset,
          label: preset === 'small' ? 'S' : preset === 'large' ? 'L' : 'M',
          title:
            preset === 'small'
              ? t('subtitleFontSmall')
              : preset === 'large'
              ? t('subtitleFontLarge')
              : t('subtitleFontMedium'),
          active: fontSize === preset,
          onSelect: () => setFontSize(preset),
        }))
      : [];

  const fatalStageLabel = (stage: string) => {
    switch (stage) {
      case 'asr':
        return t('subtitleFatalStageAsr');
      case 'segmentation':
        return t('subtitleFatalStageSegmentation');
      case 'translation':
        return t('subtitleFatalStageTranslation');
      case 'capture':
      case 'feed':
        return t('subtitleFatalStageCapture');
      case 'stream':
        return t('subtitleFatalStageStream');
      case 'lifecycle':
        return t('subtitleFatalStageLifecycle');
      default:
        return t('subtitleFatalStageUnknown');
    }
  };

  const fatalMessage = (error: SubtitleFatalError) => {
    const code = error.code || '';
    if (code === 'ASR_DONE_TIMEOUT') return t('subtitleErrorAsrTimeout');
    if (code.startsWith('ASR_')) return t('subtitleErrorAsr');
    if (code.startsWith('SAT_') || code.startsWith('ML_HELPER_')) {
      return t('subtitleErrorSegmentation');
    }
    if (code.startsWith('TRANSLATION_')) return t('subtitleErrorTranslation');
    if (
      code.startsWith('CAPTURE_') ||
      code.startsWith('FEED_') ||
      code.startsWith('PCM_')
    ) {
      return t('subtitleErrorCapture');
    }
    if (
      code.startsWith('SSE_') ||
      code.startsWith('BAD_') ||
      code.startsWith('DUPLICATE_') ||
      code.startsWith('UNKNOWN_')
    ) {
      return t('subtitleErrorStream');
    }
    if (
      code.startsWith('RUNTIME_') ||
      code.startsWith('START_') ||
      code.startsWith('MODELS_') ||
      code === 'SERVICE_LOST'
    ) {
      return t('subtitleErrorLifecycle');
    }
    return t('subtitleErrorGeneric');
  };

  return (
    <div
      className="w-full h-full flex flex-col select-none bg-transparent font-sans antialiased box-border"
      onClick={() => {
        if (showFontMenu) setShowFontMenu(false);
        if (showSourceMenu) setShowSourceMenu(false);
        if (showTargetMenu) setShowTargetMenu(false);
      }}
    >
      <div
        className="relative w-full h-full rounded-[16px] flex flex-col text-white overflow-hidden border border-white/[0.22]"
        style={{
          // 液态玻璃表面：原生材质负责真正的模糊/折射（NSGlassEffectView），
          // 这里只叠一层很薄的暗色 scrim 保住白字对比，外加顶部高光与内缘亮线。
          backgroundColor: 'rgba(12, 14, 18, 0.30)',
          backgroundImage:
            'linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.035) 34%, rgba(255,255,255,0) 70%)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -1px 0 rgba(255,255,255,0.08), inset 0 0 26px rgba(255,255,255,0.05)',
        }}
      >
        {/* 顶部控制栏（固定 38px 高度） */}
        <div
          onMouseDown={handleMouseDownOnHeader}
          className="h-[38px] flex items-center justify-between px-4 border-b border-white/[0.08] text-[12px] cursor-move select-none shrink-0"
        >
          {/* 左侧：声音源 / 翻译目标语言 / 关闭原文 / 字体大小 */}
          <div className="flex items-center gap-3.5 text-neutral-100" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>
            {/* 声音源下拉菜单 */}
            <div className="relative" data-no-drag>
              <button
                type="button"
                title={sourceLang === 'zh' ? t('subtitleSourceAudioZh') : t('subtitleSourceAudioEn')}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSourceMenu((prev) => !prev);
                  setShowTargetMenu(false);
                  setShowFontMenu(false);
                }}
                className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/10 font-medium text-white/95 transition cursor-pointer whitespace-nowrap"
              >
                <Volume2 className="w-3.5 h-3.5 text-white/90" />
                {!compactBar && (
                  <span>{sourceLang === 'zh' ? t('subtitleSourceAudioZh') : t('subtitleSourceAudioEn')}</span>
                )}
                <ChevronDown className="w-3 h-3 text-white/80" />
                <span
                  title={
                    !allReady
                      ? `${t('subtitlePreparingModels')} (${readyDiskCount}/3)`
                      : showLoadingScreen
                      ? `${t('subtitleLoadingModelsTitle')} (${activeStepDisplay}/3)`
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
              </button>
            </div>

            {/* 翻译目标语言下拉菜单 */}
            <div className="relative" data-no-drag>
              <button
                type="button"
                title={targetLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowTargetMenu((prev) => !prev);
                  setShowSourceMenu(false);
                  setShowFontMenu(false);
                }}
                className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/10 font-medium text-white/95 transition cursor-pointer whitespace-nowrap"
              >
                <Globe className="w-3.5 h-3.5 text-white/90" />
                {!compactBar && <span>{targetLabel}</span>}
                <ChevronDown className="w-3 h-3 text-white/80" />
              </button>
            </div>

            {/* 关闭原文 / 开启原文 开关（不翻译纯字幕模式下锁定且不可点击） */}
            <button
              type="button"
              disabled={isNone}
              onClick={(e) => {
                e.stopPropagation();
                if (isNone) return;
                setShowOriginal((prev) => !prev);
              }}
              title={
                isNone
                  ? t('subtitleOriginalLocked')
                  : showOriginal
                  ? t('subtitleHideOriginal')
                  : t('subtitleShowOriginal')
              }
              className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded transition whitespace-nowrap ${
                isNone
                  ? 'opacity-40 cursor-not-allowed text-neutral-400'
                  : 'hover:bg-white/10 text-white/90 hover:text-white cursor-pointer'
              }`}
            >
              <span className="relative inline-flex items-center justify-center px-1 py-[1px] text-[9px] font-bold leading-none rounded-[3px] border border-white/80 text-white">
                cc
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-[#222327] ${
                    showOriginal || isNone ? 'bg-emerald-400' : 'bg-neutral-500'
                  }`}
                />
              </span>
              <span>{!compactBar && (showOriginal || isNone ? t('subtitleHideOriginal') : t('subtitleShowOriginal'))}</span>
            </button>

            {/* Aa 字体大小下拉菜单 */}
            <div className="relative" data-no-drag>
              <button
                type="button"
                title={fontSizeLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFontMenu((prev) => !prev);
                  setShowSourceMenu(false);
                  setShowTargetMenu(false);
                }}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 text-white/95 hover:text-white transition cursor-pointer whitespace-nowrap"
              >
                <span className="text-[12px] font-semibold tracking-tight">Aa</span>
                {!compactBar && <span>{fontSizeLabel}</span>}
                <ChevronDown className="w-3 h-3 text-white/80" />
              </button>
            </div>
          </div>

          {/* 右侧：行数档位标签 / 清空 / 暂停 / 关闭 */}
          <div className="flex items-center gap-2 text-white/95" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>
            {allReady && modelsLoaded && !showLoadingScreen && (
              <span className="text-[11px] font-mono font-medium text-white/95 px-1 select-none">
                {isSingleTrack ? `${linePairs}L` : `${linePairs}+${linePairs}`}
              </span>
            )}

            {modelsLoaded && hasAnyContent && (
              <button
                type="button"
                onClick={handleClearHistory}
                title={t('subtitleClearHistory')}
                className="p-1 rounded hover:bg-white/10 text-white/90 hover:text-white transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            {allReady && modelsLoaded && !showLoadingScreen && (
              <button
                type="button"
                onClick={toggleListening}
                title={isRunning ? t('subtitlePauseCapture') : t('subtitleResumeCapture')}
                className="p-1 rounded hover:bg-white/10 text-white/90 hover:text-white transition cursor-pointer"
              >
                {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
            )}

            <button
              type="button"
              onClick={handleClose}
              title={t('subtitleClose')}
              className="w-5 h-5 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center transition cursor-pointer ml-0.5"
            >
              <X className="w-3 h-3" strokeWidth={2.5} />
            </button>
          </div>
        </div>

        {/* 横向选项带：贴在工具栏正下方，盖住字幕区顶部，带下沿的投影压住下面的内容。
            整条带子永远在卡片内部 —— 不越界、不改窗口尺寸，所以既不会被裁掉也不会抖。 */}
        {openMenu && (
          <div
            data-subtitle-options={openMenu}
            onClick={(e) => e.stopPropagation()}
            className="absolute left-0 right-0 top-[38px] z-30 flex items-center gap-1.5 px-3 h-[30px] bg-white/[0.03] backdrop-blur-[6px] border-t border-white/[0.09] shadow-[0_10px_18px_-12px_rgba(0,0,0,0.7)]"
          >
            {optionChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                title={chip.title}
                onClick={(e) => {
                  e.stopPropagation();
                  chip.onSelect();
                  setShowSourceMenu(false);
                  setShowTargetMenu(false);
                  setShowFontMenu(false);
                }}
                className={`px-2 py-[3px] rounded text-[11px] font-semibold tracking-wide transition-colors ${
                  chip.active
                    ? 'bg-emerald-400/20 text-emerald-300 ring-1 ring-inset ring-emerald-400/40'
                    : 'text-neutral-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}

        {/* 主内容区域 */}
        {fatalError ? (
          <div className="flex-1 px-5 py-4 flex flex-col justify-center gap-2.5 text-xs select-text">
            <div className="flex items-center gap-2 text-red-400 font-semibold">
              <X className="w-4 h-4" />
              <span>{t('subtitleFatalTitle')}</span>
            </div>
            <div className="font-mono text-[10px] text-red-300/80">
              {fatalStageLabel(fatalError.stage)} / {fatalError.code}
            </div>
            <div className="text-neutral-200 break-words">
              {fatalMessage(fatalError)}
            </div>
            <div className="text-neutral-400 text-[11px] leading-snug">{t('subtitleFatalHint')}</div>
            <div className="pt-1">
              <button
                type="button"
                onClick={handleClose}
                className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-neutral-100 text-[11px] transition cursor-pointer"
              >
                {t('subtitleFatalClose')}
              </button>
            </div>
          </div>
        ) : !allReady ? (
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
          /* 严格等行提词器流：原文/源文 linePairs 行 + 译文 linePairs 行；选“不翻译”时仅展示单轨纯字幕 */
          <div
            className={`flex-1 px-4 pt-[10px] pb-[12px] flex flex-col justify-between overflow-hidden select-text ${
              isSingleTrack ? '' : 'gap-[8px]'
            }`}
          >
            {!hasAnyContent ? (
              <div
                className="h-full flex items-center justify-center text-white/85 text-[13px] select-none"
                style={{ textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}
              >
                {isRunning
                  ? (sourceLang === 'zh' ? t('subtitleWaitingAudioZh') : t('subtitleWaitingAudioEn'))
                  : t('subtitleCapturePaused')}
              </div>
            ) : (
              <>
                {/* 上轨：linePairs 行源文字幕连续流（与译文完全统一配色与字重） */}
                {(showOriginal || isNone) && (
                  <div
                    ref={enStreamRef}
                    style={{
                      height: `${(isNone ? singleTrackLineHeight : fontCfg.enLineHeight) * linePairs}px`,
                      fontSize: `${isNone ? (sourceLang === 'zh' ? fontCfg.zhFontSize : fontCfg.enFontSize) : fontCfg.enFontSize}px`,
                      lineHeight: `${(isNone ? singleTrackLineHeight : fontCfg.enLineHeight)}px`,
                      // 玻璃底与浅色背景上保住高对比：与译文完全统一的纯白双重高对比文字阴影
                      textShadow: '0 1px 3px rgba(0,0,0,0.85), 0 0 10px rgba(0,0,0,0.6)',
                    }}
                    className="w-full overflow-y-hidden font-bold text-white tracking-wide break-words scroll-smooth shrink-0"
                  >
                    {continuousSourceText}
                  </div>
                )}

                {/* 下轨：linePairs 行目标语言翻译连续流（不翻译模式下自动隐藏） */}
                {!isNone && (
                  <div
                    ref={zhStreamRef}
                    style={{
                      height: `${fontCfg.zhLineHeight * linePairs}px`,
                      fontSize: `${fontCfg.zhFontSize}px`,
                      lineHeight: `${fontCfg.zhLineHeight}px`,
                      textShadow: '0 1px 3px rgba(0,0,0,0.85), 0 0 10px rgba(0,0,0,0.6)',
                    }}
                    className="w-full overflow-y-hidden font-bold text-white tracking-wide break-words scroll-smooth shrink-0"
                  >
                    {continuousTargetText}
                    {hasPendingTarget && (
                      <span className="ml-1 text-white/70 font-normal text-[0.8em]">
                        {t('subtitlePendingTranslation')}
                      </span>
                    )}
                  </div>
                )}
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
