import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Search, Trash2, Folder, Pause, Play, List, LayoutGrid,
  FileText, Loader2, AlertCircle, Download,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { StartupOverlay } from '../StartupOverlay';

/**
 * 文件夹快速检索独立窗口（hash 路由 `#/folder_search`）。
 *
 * 形态：左侧文件夹列表（与主界面会话列表同款视觉）+ 右侧检索台。
 * 生命周期全部交给原生窗口：`folderSearch` 桥只在开窗/关窗时打点，
 * 页面自己只做 HTTP 轮询（/list、/status、/model）。
 *
 * 与后端的约定：
 *   - 打开窗口 → POST /open（后端会按需续建，暂停态不动）
 *   - 关闭窗口 → 原生侧发 POST /close（当前批落盘后停索引并卸载模型）
 */

const API = '/api/folder_index';

type IndexItem = {
  id: string;
  root: string;
  name: string;
  paused: boolean;
  files: number;
  done: number;
  pages: number;
  chunks: number;
  images: number;
  running: boolean;
  exists: boolean;
  dim?: number;
  progress: { phase: string; done?: number; total?: number; chunks?: number; current?: string; error?: string } | null;
};

type EmbedStatus = {
  installed: 'none' | 'text' | 'full';
  installedBytes: number;
  loaded: boolean;
  downloading: boolean;
  progress: { file: string; received: number; total: number; index: number; count: number } | null;
};

type Hit = { relPath: string; name: string; dir: string; page: number; text: string; score: number };

const br = (window as any).webkit?.messageHandlers?.folderSearch;

function post(action: string, payload: any = {}) {
  br?.postMessage({ action, ...payload });
}

const isImage = (name: string) => /\.(png|jpe?g|heic|heif|webp|tiff?|gif|bmp)$/i.test(name);

export const FolderSearchWindow: React.FC = () => {
  const { t } = useI18n();
  const [items, setItems] = useState<IndexItem[]>([]);
  const [embed, setEmbed] = useState<EmbedStatus | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [searching, setSearching] = useState(false);
  const [ready, setReady] = useState(false);
  // 与主界面同一套启动遮罩：探到本地服务端口就绪后淡出
  const [showStartupOverlay, setShowStartupOverlay] = useState(true);
  const searchSeq = useRef(0);

  const active = useMemo(() => items.find((x) => x.id === activeId) || null, [items, activeId]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/list`);
      const data = await r.json();
      setItems(data.items || []);
      setEmbed(data.embed || null);
      setReady(true);
      setActiveId((prev) => {
        if (prev && data.items?.some((x: IndexItem) => x.id === prev)) return prev;
        return data.items?.[0]?.id || null;
      });
    } catch {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // 原生选完文件夹后回调：直接把列表拉新（页面不需要重新加载）
  useEffect(() => {
    (window as any).__folderSearchAdded = () => refresh();
    return () => { delete (window as any).__folderSearchAdded; };
  }, [refresh]);

  // 有索引在跑 / 模型在下载时轮询
  useEffect(() => {
    const busy = items.some((x) => x.running) || !!embed?.downloading;
    if (!busy) return;
    const id = setInterval(refresh, 800);
    return () => clearInterval(id);
  }, [items, embed, refresh]);

  // 切换文件夹 → 通知后端开窗（按需续建）
  useEffect(() => {
    if (!activeId) return;
    fetch(`${API}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeId }),
    }).catch(() => {});
  }, [activeId]);

  // 关窗 → 停索引 + 卸载模型
  useEffect(() => {
    const handler = () => {
      fetch(`${API}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeId }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [activeId]);

  const runSearch = useCallback(async (q: string, id: string) => {
    const seq = ++searchSeq.current;
    if (!q.trim()) { setHits([]); setElapsed(0); return; }
    setSearching(true);
    try {
      const r = await fetch(`${API}/search?id=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}&limit=60`);
      const data = await r.json();
      if (seq !== searchSeq.current) return;
      setHits(data.items || []);
      setElapsed(data.elapsedMs || 0);
    } catch {
      if (seq === searchSeq.current) setHits([]);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  // 300ms 防抖
  useEffect(() => {
    if (!activeId) return;
    const t = setTimeout(() => runSearch(query, activeId), 300);
    return () => clearTimeout(t);
  }, [query, activeId, runSearch]);

  /** 外部（Finder 右键 / URL scheme）指定一个文件夹：直接建索引并切过去 */
  const addPath = useCallback(async (folderPath: string) => {
    if (!folderPath) return;
    try {
      const r = await fetch(`${API}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath }),
      });
      const data = await r.json();
      await refresh();
      if (data.item?.id) setActiveId(data.item.id);
    } catch {}
  }, [refresh]);

  useEffect(() => {
    (window as any).__folderSearchAddPath = (p: string) => { addPath(p); };
    const m = window.location.hash.match(/[?&]add=([^&]+)/);
    if (m) addPath(decodeURIComponent(m[1]));
    return () => { delete (window as any).__folderSearchAddPath; };
  }, [addPath]);

  const addFolder = () => post('pick');
  const removeFolder = async (id: string) => {
    await fetch(`${API}/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
  };
  const togglePause = async () => {
    if (!active) return;
    if (active.paused) {
      await fetch(`${API}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: active.id }),
      });
    } else {
      await fetch(`${API}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: active.id, paused: true }),
      });
    }
    refresh();
  };

  const prepareModel = async () => {
    await fetch(`${API}/model/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ needVision: true }),
    });
    refresh();
  };

  const pct = active?.progress?.total
    ? Math.round(((active.progress.done || 0) / active.progress.total) * 100)
    : 0;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#f8f9fb] dark:bg-[#18191c] text-[#1f2328] dark:text-[#f1f3f7] select-none">
      {showStartupOverlay && (
        <StartupOverlay onFinished={() => setShowStartupOverlay(false)} />
      )}
      {/* ───────── 左：文件夹列表（与主界面 Sidebar 同款） ───────── */}
      <aside className="w-[260px] min-w-[260px] h-full flex flex-col border-r border-black/5 dark:border-white/5 bg-[#f1f3f6] dark:bg-[#1a1b1f]">
        <div className="h-[52px] flex items-center justify-end px-3">
          <div className="w-[78px]" />
        </div>
        <div className="px-4 pt-1 pb-3">
          <h1 className="text-xl font-bold tracking-tight">{t('folderSearchWindowTitle')}</h1>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={addFolder}
            className="w-full flex items-center justify-between py-2.5 px-3.5 rounded-xl bg-white hover:bg-[#e8ebf0] dark:bg-[#25262c] dark:hover:bg-[#2d2e35] active:scale-[0.99] text-sm font-medium transition-all border border-black/5 dark:border-white/5 shadow-sm group"
          >
            <span className="flex items-center gap-2">
              <Plus className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
              {t('folderSearchAddFolder')}
            </span>
            <Folder className="w-4 h-4 text-zinc-400 dark:text-zinc-500" />
          </button>
        </div>

        <div className="px-3.5 pt-3 pb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-500 dark:text-zinc-400 tracking-wide">
          <span className="uppercase">{t('folderSearchIndexedFolders')}</span>
          <span>{items.length}</span>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {items.length === 0 && ready && (
            <div className="px-3 py-10 text-center text-xs text-zinc-500 leading-relaxed">
              {t('folderSearchEmptyList')}<br />{t('folderSearchEmptyListHint')}
            </div>
          )}
          {items.map((it) => {
            const on = it.id === activeId;
            const p = it.progress;
            const busy = it.running;
            const pctIt = p?.total ? Math.round(((p.done || 0) / p.total) * 100) : 0;
            return (
              <div
                key={it.id}
                onClick={() => setActiveId(it.id)}
                className={`group relative rounded-xl px-2.5 py-2 flex gap-2.5 cursor-pointer transition-colors ${
                  on ? 'bg-white dark:bg-[#2b2d34] shadow-sm' : 'hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  on ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'bg-black/5 dark:bg-white/5 text-zinc-500 dark:text-zinc-400'
                }`}>
                  <Folder className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{it.name}</div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{it.root}</div>
                  <div className="text-[10.5px] text-zinc-500 dark:text-zinc-400 mt-1 flex items-center gap-1.5">
                    <span className={`w-[5px] h-[5px] rounded-full ${
                      !it.exists ? 'bg-red-500' : busy ? 'bg-blue-500' : it.paused ? 'bg-amber-500' : 'bg-emerald-500'
                    }`} />
                    {!it.exists
                      ? t('folderSearchMissing')
                      : busy
                      ? `${t('folderSearchIndexing')} ${pctIt}% · ${it.chunks} ${t('folderSearchBlocksUnit')}`
                      : it.paused
                      ? `${t('folderSearchPaused')} · ${it.chunks} ${t('folderSearchBlocksUnit')}`
                      : `${it.files} ${t('folderSearchFilesUnit')} · ${it.pages} ${t('folderSearchPagesUnit')} · ${it.chunks} ${t('folderSearchBlocksUnit')}`}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeFolder(it.id); }}
                  title={t('folderSearchDelete')}
                  className="absolute right-1.5 top-1.5 w-6 h-6 rounded-md hidden group-hover:flex items-center justify-center text-zinc-500 hover:text-red-500 hover:bg-red-500/10"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="px-3.5 py-2.5 border-t border-black/5 dark:border-white/5 text-[10.5px] leading-relaxed text-zinc-500 dark:text-zinc-500">
          EmbeddingGemma-2 · {embed?.installed === 'full' ? '文本 + 视觉 int8' : embed?.installed === 'text' ? '仅文本 int8' : '未下载'}
          <br />{t('folderSearchLocalOnly')}
        </div>
      </aside>

      {/* ───────── 右：检索台 ───────── */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="h-[52px] flex items-center gap-2.5 px-4 border-b border-black/5 dark:border-white/5 flex-shrink-0">
          <span className="text-[13.5px] font-semibold truncate">{active?.name || t('folderSearchWindowTitle')}</span>
          {active && (
            <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
              {query
                ? `${hits.length} ${t('folderSearchResults')}`
                : `${active.files} ${t('folderSearchFilesUnit')} · ${active.chunks} ${t('folderSearchBlocksUnit')}`}
            </span>
          )}
          <div className="flex-1" />
          {active && (
            <>
              <button
                onClick={() => setView('list')}
                className={`h-7 px-2.5 rounded-full text-xs flex items-center gap-1.5 border transition-colors ${
                  view === 'list'
                    ? 'bg-blue-600 text-white border-transparent'
                    : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <List className="w-3.5 h-3.5" />{t('folderSearchList')}
              </button>
              <button
                onClick={() => setView('grid')}
                className={`h-7 px-2.5 rounded-full text-xs flex items-center gap-1.5 border transition-colors ${
                  view === 'grid'
                    ? 'bg-blue-600 text-white border-transparent'
                    : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />{t('folderSearchGrid')}
              </button>
              <button
                onClick={togglePause}
                className="h-7 px-2.5 rounded-full text-xs flex items-center gap-1.5 border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
              >
                {active.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                {active.paused ? t('folderSearchResume') : t('folderSearchPause')}
              </button>
            </>
          )}
        </div>

        {embed?.installed === 'none' && (
          <div className="mx-5 mt-4 rounded-2xl border border-amber-500/30 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex items-center gap-3">
            <Download className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium">{t('folderSearchModelTitle')}</div>
              <div className="text-[11.5px] text-zinc-600 dark:text-zinc-400 mt-0.5">
                {embed.downloading
                  ? `${t('folderSearchModelDownloading')} ${embed.progress?.file || ''} ${embed.progress ? Math.round((embed.progress.received / Math.max(embed.progress.total, 1)) * 100) : 0}%`
                  : t('folderSearchModelDesc')}
              </div>
            </div>
            {!embed.downloading && (
              <button onClick={prepareModel} className="h-8 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium">
                {t('folderSearchStartDownload')}
              </button>
            )}
          </div>
        )}

        <div className="px-4 pt-4 pb-2 flex-shrink-0">
          <div className="h-[46px] rounded-[23px] border border-black/10 dark:border-white/10 bg-white dark:bg-[#25262c] shadow-lg dark:shadow-xl flex items-center gap-2.5 px-4">
            <Search className="w-4 h-4 text-zinc-400 flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('folderSearchPlaceholder')}
              className="flex-1 bg-transparent text-[14px] outline-none placeholder-zinc-400"
              autoFocus
            />
            {searching && <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />}
            {query && (
              <button onClick={() => setQuery('')} className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
                {t('folderSearchClear')}
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {!query && (
            <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-zinc-500">
              <Search className="w-7 h-7 opacity-25" />
              <div className="text-[13px]">
                {active ? t('folderSearchSearchHint') : t('folderSearchPickFirst')}
              </div>
              {active && (
                <div className="text-[11.5px] opacity-70">
                  {t('folderSearchSearchHintSub')}
                </div>
              )}
            </div>
          )}

          {query && !searching && hits.length === 0 && (
            <div className="h-40 flex flex-col items-center justify-center text-center text-zinc-500 gap-1.5">
              <AlertCircle className="w-5 h-5 opacity-40" />
              <div className="text-[13px]">{t('folderSearchNoResult')}</div>
              <div className="text-[11.5px] opacity-70">{t('folderSearchNoResultHint')}</div>
            </div>
          )}

          {view === 'list' && hits.map((h, i) => (
            <div
              key={`${h.relPath}-${h.page}-${i}`}
              onClick={() => post('open', { path: `${active?.root}/${h.relPath}` })}
              className="flex gap-3 px-3 py-2.5 rounded-xl cursor-pointer hover:bg-white dark:hover:bg-[#202126] border border-transparent hover:border-black/5 dark:hover:border-white/5"
            >
              <div className="w-9 h-9 rounded-lg bg-black/5 dark:bg-white/5 flex items-center justify-center flex-shrink-0 text-zinc-500 overflow-hidden">
                {isImage(h.name)
                  ? <img src={`${API}/thumb?id=${active?.id}&rel=${encodeURIComponent(h.relPath)}`} alt="" className="w-full h-full object-cover" />
                  : <FileText className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium truncate">{h.name}</span>
                  {h.page > 0 && (
                    <span className="text-[10.5px] text-zinc-500 bg-black/5 dark:bg-white/10 rounded px-1.5 py-px flex-shrink-0">
                      P{h.page}
                    </span>
                  )}
                </div>
                {h.dir && <div className="text-[11px] text-zinc-500 truncate mt-0.5">{h.dir}/</div>}
                <div className="text-[12px] text-zinc-600 dark:text-zinc-400 mt-1 line-clamp-2 leading-relaxed">
                  {h.text}
                </div>
              </div>
              <div className="text-[11px] text-zinc-500 tabular-nums flex-shrink-0 pt-0.5">
                {h.score.toFixed(2)}
              </div>
            </div>
          ))}

          {view === 'grid' && (
            <div className="grid grid-cols-3 gap-2.5 px-1 py-1">
              {hits.map((h, i) => (
                <div
                  key={`${h.relPath}-${i}`}
                  onClick={() => post('open', { path: `${active?.root}/${h.relPath}` })}
                  className="relative rounded-xl overflow-hidden bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5 cursor-pointer aspect-[16/10]"
                >
                  {isImage(h.name) ? (
                    <img
                      src={`${API}/thumb?id=${active?.id}&rel=${encodeURIComponent(h.relPath)}`}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-3">
                      <FileText className="w-5 h-5 text-zinc-400" />
                      <span className="text-[11.5px] text-zinc-500 truncate w-full text-center">{h.name}</span>
                    </div>
                  )}
                  <span className="absolute right-1.5 bottom-1.5 text-[10.5px] text-white bg-black/55 rounded px-1.5 py-px tabular-nums">
                    {h.score.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="h-[34px] flex items-center gap-3 px-4 text-[11.5px] text-zinc-500 border-t border-black/5 dark:border-white/5 flex-shrink-0">
          {active?.running && active.progress ? (
            <>
              <span className="truncate">
                {t('folderSearchIndexing')} {active.progress.done || 0}/{active.progress.total || 0}
                {active.progress.current ? ` · ${active.progress.current}` : ''}
              </span>
              <div className="flex-1 max-w-[180px] h-[3px] rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </>
          ) : (
            <span>{active ? `${active.chunks} ${t('folderSearchBlocksUnit')} · ${active.dim || 256}d` : ''}</span>
          )}
          <div className="flex-1" />
          {elapsed > 0 && <span>{elapsed}ms</span>}
        </div>
      </main>
    </div>
  );
};
