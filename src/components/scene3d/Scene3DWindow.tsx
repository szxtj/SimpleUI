import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Boxes,
  Copy,
  Check,
  Maximize2,
  Plus,
  RotateCw,
  Square,
  Trash2,
  X,
  AlertTriangle,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { ChatMessage, Scene3dServiceStatus } from '../../types/chat';
import { Scene3dServiceAPI } from '../../services/api';
import { useScene3dStore } from '../../hooks/useScene3dStore';
import { deriveServiceState, formatServiceStateText, SERVICE_STATE_CARD_DOT_CLASS } from '../../utils/serviceState';
import { ImageAttachment } from '../ImageAttachment';
import { ImagePreviewModal } from '../ImagePreviewModal';
import { ThinkingAccordion } from '../ThinkingAccordion';
import { extractImagesFromPaste, fileToDataURL } from '../../utils/image';
import { useImeInput } from '../../hooks/useImeInput';

/**
 * 3D 场景构建独立窗口（原生 Scene3DPanelController 承载，hash 路由 #/scene3d）。
 *
 * 生命周期契约：挂载时 Scene3dServiceAPI.ensure()（后台拉起/补下载，不阻塞），
 * 卸载时 release()（关窗即卸载模型）。发送按钮在服务 ready 前禁用。
 */

const SceneSessionList: React.FC<{
  sessions: { id: string; title: string }[];
  currentId: string | null;
  generatingIds: string[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  newLabel: string;
}> = ({ sessions, currentId, generatingIds, onSelect, onDelete, onNew, newLabel }) => {
  const { t } = useI18n();
  return (
    <div className="w-[260px] min-w-[260px] flex-shrink-0 h-full flex flex-col border-r border-black/5 dark:border-white/5 bg-[#f1f3f6] dark:bg-[#1a1b1f] select-none">
      {/* 开放式窗口（原生 titlebar 隐藏、内容伸到窗口顶边）：顶部 52px 是与原生拖拽带等高的
          留白带，左侧 78px 让给原生红绿黄三个按钮；品牌行落在红绿灯下方，
          与主界面 Sidebar 的品牌标题同一套排布。 */}
      <div className="h-[52px] flex-shrink-0" aria-hidden="true" />

      <div className="px-4 pt-1 pb-3">
        <h1 className="text-xl font-bold tracking-tight text-[#1f2328] dark:text-[#f1f3f7]">
          {t('scene3dWindowTitle')}
        </h1>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-between py-2.5 px-3.5 rounded-xl bg-white hover:bg-[#e8ebf0] dark:bg-[#25262c] dark:hover:bg-[#2d2e35] active:scale-[0.99] text-[#1f2328] dark:text-[#f1f3f7] text-sm font-medium transition-all border border-black/5 dark:border-white/5 shadow-sm group"
        >
          <span className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-zinc-600 group-hover:text-zinc-900 dark:text-zinc-300 dark:group-hover:text-white transition-colors" />
            <span>{newLabel}</span>
          </span>
          <Boxes className="w-4 h-4 text-zinc-400 group-hover:text-zinc-600 dark:text-zinc-500 dark:group-hover:text-zinc-300 transition-colors" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {sessions.map((s) => {
          const active = s.id === currentId;
          const generating = generatingIds.includes(s.id);
          return (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-xl cursor-pointer text-sm transition-colors ${
                active
                  ? 'bg-white dark:bg-[#2b2d34] shadow-sm text-[#1f2328] dark:text-[#f1f3f7]'
                  : 'text-zinc-600 hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-white'
              }`}
            >
              <span className="flex-1 truncate" title={s.title}>
                {s.title}
              </span>
              {generating ? (
                <RotateCw className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-zinc-400 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 transition-all flex-shrink-0"
                  title={t('delete')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const SceneCard: React.FC<{
  html: string;
  tokensPerSecond?: number;
}> = ({ html }) => {
  const { t } = useI18n();
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // 全屏预览盖住整个窗口（含原生拖拽带）：把状态告诉原生，
  // 让拖拽层把顶栏右侧那组工具按钮放行，否则按钮全被吃掉、点了没反应。
  useEffect(() => {
    const post = (preview: boolean) => {
      try {
        (window as any).webkit?.messageHandlers?.scene3dChrome?.postMessage({ preview });
      } catch {
        /* 浏览器里没有原生桥，忽略 */
      }
    };
    post(fullscreen);
    return () => post(false);
  }, [fullscreen]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore
    }
  };

  const iframe = (
    <iframe
      key={reloadKey}
      title="3D Scene"
      sandbox="allow-scripts"
      srcDoc={html}
      className="w-full h-full border-0 bg-black"
    />
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        {/* 顶部 52px 预留条：与窗口开放式顶栏等高。
            左 78px 让给原生红绿灯，右侧是本覆盖层的工具按钮，中间留空可拖动窗口；
            场景 HTML 从这条带**下方**开始渲染 —— 它自带的标题/控件不会再被窗口顶栏压住。 */}
        <div className="h-[52px] flex-shrink-0 flex items-center justify-between px-3 bg-black/80 backdrop-blur-md border-b border-white/10 select-none">
          <div className="w-[78px] h-full flex-shrink-0" />
          <div className="flex items-center gap-2">
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur transition-colors"
              title={t('scene3dReloadScene')}
            >
              <RotateCw className="w-4 h-4" />
            </button>
            <button
              onClick={copyCode}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur transition-colors"
              title={t('scene3dCopyHtml')}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setFullscreen(false)}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur transition-colors"
              title={t('scene3dClosePreview')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">{iframe}</div>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-2xl overflow-hidden border border-black/10 dark:border-white/10 bg-black shadow-lg">
      <div className="h-[320px] cq-md:h-[420px]">{iframe}</div>
      <div className="flex items-center justify-between px-3 py-2 bg-white dark:bg-[#25262c] border-t border-black/5 dark:border-white/5">
        <button
          onClick={copyCode}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? t('scene3dCopyDone') : t('scene3dCopyHtml')}</span>
        </button>
        <button
          onClick={() => setFullscreen(true)}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          <span>{t('scene3dOpenPreview')}</span>
        </button>
      </div>
    </div>
  );
};

const SceneMessageItem: React.FC<{ message: ChatMessage; generating?: boolean }> = ({
  message,
  generating = false,
}) => {
  const { t, lang } = useI18n();

  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1.5 my-3">
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 justify-end">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={img}
                alt=""
                className="w-20 h-20 object-cover rounded-xl border border-black/10 dark:border-white/10"
              />
            ))}
          </div>
        )}
        {message.content?.trim() && (
          <div className="max-w-[78%] px-4 py-2.5 rounded-2xl bg-blue-600 text-white text-[15px] leading-relaxed whitespace-pre-wrap break-words shadow-md">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  // assistant：流式期间正文是整页 HTML 源码，不直接渲染——统一走「生成中」进度卡片
  const busy = message.pending || message.isThinking || !!message.stage || generating;
  const sceneHtml = message.scene?.html;

  return (
    <div className="my-3">
      <ThinkingAccordion
        content={message.reasoningContent}
        isThinking={message.isThinking}
        duration={message.thinkingDuration}
      />

      {message.error ? (
        <div className="mt-2 flex items-center gap-2 text-sm text-red-500">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>
            {t('scene3dFailed')}
            {message.error ? `: ${message.error}` : ''}
          </span>
        </div>
      ) : sceneHtml ? (
        <SceneCard html={sceneHtml} />
      ) : busy ? (
        <div className="mt-2 rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-[#25262c] px-4 py-3.5 shadow-sm">
          <div className="flex items-center gap-2.5">
            <RotateCw className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {t('scene3dGenerating')}
            </span>
            {message.metrics?.completionTokens ? (
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                {message.metrics.completionTokens} tok
              </span>
            ) : null}
          </div>
          {/* 简单的流式进度感：细长渐变进度条动画（生成时长通常以分钟计） */}
          <div className="mt-2.5 h-1 rounded-full overflow-hidden bg-black/5 dark:bg-white/10">
            <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-blue-500 to-transparent animate-[scene3dSlide_1.8s_ease-in-out_infinite]" />
          </div>
          {lang === 'zh' ? (
            <div className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
              一个完整场景通常需要 5–30 分钟，可随时切走或停止
            </div>
          ) : (
            <div className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
              A full scene typically takes 5–30 minutes; you can switch away or stop anytime
            </div>
          )}
        </div>
      ) : message.content?.trim() ? (
        // 有正文但没有 scene（服务端判定为空/围栏剥除后为空）：按代码块展示原始内容
        <pre className="mt-2 max-h-64 overflow-auto rounded-2xl bg-zinc-950 text-zinc-200 text-xs p-4 whitespace-pre-wrap break-words">
          {message.content}
        </pre>
      ) : null}
    </div>
  );
};

export const Scene3DWindow: React.FC = () => {
  const { t, lang } = useI18n();
  const {
    sessions,
    currentSessionId,
    currentSession,
    messages,
    generatingSessionIds,
    isGenerating,
    liveStreamingTokens,
    selectSession,
    createOrReuseEmptySession,
    deleteSession,
    sendTurn,
    abortTurn,
    refreshState,
  } = useScene3dStore(lang === 'en' ? 'New Scene' : '新场景');

  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [previewDraftIndex, setPreviewDraftIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<Scene3dServiceStatus | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const serviceState = useMemo(
    () =>
      deriveServiceState({
        status: status?.status,
        running: status?.running,
        loaded: status?.modelsReady,
      }),
    [status]
  );
  const serviceReady = serviceState === 'online';

  // ---- 服务生命周期：挂载 ensure / 卸载 release，轮询状态 ----
  useEffect(() => {
    Scene3dServiceAPI.ensure();
    const poll = window.setInterval(() => {
      Scene3dServiceAPI.getStatus().then(setStatus);
    }, 1500);
    Scene3dServiceAPI.getStatus().then(setStatus);
    return () => {
      window.clearInterval(poll);
      Scene3dServiceAPI.release();
    };
  }, []);

  // ---- 新机全流程接缝：ensure 触发时模型往往还没下载，下载完成（incomplete →
  //      modelsReady）后不会再有人调用 ensure，这里补一次后台拉起，把
  //      「安装 → 首次下载 → 自动加载」整条链闭合。 ----
  const modelsReadyRef = useRef<boolean | null>(null);
  useEffect(() => {
    const ready = status?.modelsReady ?? null;
    const prev = modelsReadyRef.current;
    modelsReadyRef.current = ready;
    if (prev === false && ready === true) {
      Scene3dServiceAPI.ensure();
    }
  }, [status?.modelsReady]);

  // ---- 会话初始化：拉快照 + 兜底建空会话 ----
  useEffect(() => {
    refreshState().then(() => {
      createOrReuseEmptySession();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 滚动：贴底跟随，用户上滚释放 ----
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, liveStreamingTokens]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const { imeBindings } = useImeInput<HTMLTextAreaElement>({
    onEnter: () => handleSend(),
  });

  const handleSend = useCallback(() => {
    if (isGenerating || !serviceReady) return;
    const text = input.trim();
    if (!text && images.length === 0) return;
    stickToBottomRef.current = true;
    setInput('');
    setImages([]);
    sendTurn({ text, images, lang });
  }, [input, images, isGenerating, serviceReady, sendTurn, lang]);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = extractImagesFromPaste(e);
    if (files.length > 0) {
      e.preventDefault();
      try {
        const urls = await Promise.all(files.map(fileToDataURL));
        setImages((prev) => [...prev, ...urls]);
      } catch (err) {
        console.error('Failed to paste image:', err);
      }
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    try {
      const urls = await Promise.all(files.map(fileToDataURL));
      setImages((prev) => [...prev, ...urls]);
    } catch (err) {
      console.error('Failed to upload image:', err);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const liveTokens = currentSessionId ? liveStreamingTokens[currentSessionId] : undefined;

  return (
    <div className="h-full w-full flex overflow-hidden bg-[#f8f9fb] dark:bg-[#18191c] text-[#1f2328] dark:text-[#f1f3f7]">
      <SceneSessionList
        sessions={sessions}
        currentId={currentSessionId}
        generatingIds={generatingSessionIds}
        onSelect={selectSession}
        onDelete={(id) => deleteSession(id)}
        onNew={() => createOrReuseEmptySession()}
        newLabel={t('scene3dNewScene')}
      />

      {/* 主列 */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* 头部 */}
        <div className="h-[52px] flex items-center justify-between px-4 border-b border-black/5 dark:border-white/5 flex-shrink-0 select-none">
          <div className="flex items-center gap-2.5">
            <Boxes className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
            <span className="text-sm font-semibold truncate">
              {currentSession?.title || t('scene3dWindowTitle')}
            </span>
          </div>
          <div className="flex items-center gap-2" title={status?.model?.name}>
            <span
              className={`w-2 h-2 rounded-full ${SERVICE_STATE_CARD_DOT_CLASS[serviceState]}`}
            />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {status?.download?.active
                ? `${t('scene3dDownload')} ${status.download.progressPercent.toFixed(0)}%`
                : formatServiceStateText(serviceState, t, serviceReady ? status?.port : null)}
            </span>
          </div>
        </div>

        {/* 消息列表 */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-5 pb-4 selectable-chat-content"
        >
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center select-none">
              <Boxes className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mb-4" />
              <div className="text-lg font-semibold text-zinc-700 dark:text-zinc-200">
                {t('scene3dEmptyTitle')}
              </div>
              <div className="mt-2 text-sm text-zinc-400 dark:text-zinc-500 max-w-md">
                {t('scene3dEmptyHint')}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <SceneMessageItem
                key={m.id}
                message={m}
                generating={isGenerating && i === messages.length - 1}
              />
            ))
          )}
        </div>

        {/* 输入区 */}
        <div className="px-5 pb-4 flex-shrink-0">
          <div className="relative w-full rounded-[24px] border border-black/10 dark:border-white/10 focus-within:border-black/20 dark:focus-within:border-white/20 transition-all duration-200 bg-white dark:bg-[#25262c] shadow-lg dark:shadow-xl">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/heic,image/heif,image/*"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />

            <ImageAttachment
              images={images}
              onPreview={setPreviewDraftIndex}
              onRemove={(idx) => setImages((prev) => prev.filter((_, i) => i !== idx))}
            />

            <div className="px-4 pt-3.5 pb-1">
              <textarea
                data-chat-input="true"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                {...imeBindings}
                onPaste={handlePaste}
                placeholder={
                  messages.length > 0 ? t('scene3dPlaceholderFollowUp') : t('scene3dPlaceholder')
                }
                rows={1}
                className="w-full bg-transparent resize-none text-[15px] text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed max-h-[200px]"
              />
            </div>

            <div className="flex items-center justify-between px-3 pb-2.5 pt-1 select-none">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors flex-shrink-0 ${
                    images.length > 0
                      ? 'bg-blue-600 text-white shadow-sm cursor-pointer'
                      : 'bg-black/5 hover:bg-black/10 text-zinc-600 hover:text-black dark:bg-white/5 dark:hover:bg-white/10 dark:text-zinc-300 dark:hover:text-white cursor-pointer'
                  }`}
                  title={t('attachImage')}
                >
                  <Plus className="w-4 h-4 stroke-[2.5]" />
                </button>
                {!serviceReady && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 truncate">
                    {status?.download?.active
                      ? `${t('scene3dDownload')} ${status.download.progressPercent.toFixed(0)}%`
                      : status?.status === 'incomplete'
                      ? t('scene3dModelNotReady')
                      : t('scene3dWaitingModel')}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {isGenerating && liveTokens ? (
                  <span className="text-xs text-zinc-400 dark:text-zinc-500 tabular-nums">
                    {liveTokens} tok
                  </span>
                ) : null}
                {isGenerating ? (
                  <button
                    type="button"
                    onClick={() => abortTurn()}
                    className="w-8 h-8 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-transform active:scale-95 shadow-md"
                    title={t('stop')}
                  >
                    <Square className="w-3.5 h-3.5 fill-white" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={(!input.trim() && images.length === 0) || !serviceReady}
                    className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                      (input.trim() || images.length > 0) && serviceReady
                        ? 'bg-zinc-900 hover:bg-black text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-black shadow-md active:scale-95'
                        : 'bg-zinc-200 text-zinc-400 dark:bg-[#35363d] dark:text-zinc-500 cursor-not-allowed'
                    }`}
                    title={serviceReady ? t('send') : t('scene3dModelNotReady')}
                  >
                    <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                  </button>
                )}
              </div>
            </div>

            {images && images.length > 0 && previewDraftIndex !== null && (
              <ImagePreviewModal
                isOpen={previewDraftIndex !== null}
                onClose={() => setPreviewDraftIndex(null)}
                images={images}
                initialIndex={previewDraftIndex}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
