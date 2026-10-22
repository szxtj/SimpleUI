import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatSession } from '../types/chat';
import { useI18n } from '../i18n';
import { useImeInput } from '../hooks/useImeInput';
import {
  Plus,
  Trash2,
  Settings,
  Server,
  Edit2,
  Check,
  X,
  Search,
  MessageSquarePlus,
  PanelLeftClose,
  Loader2,
  PictureInPicture2,
} from 'lucide-react';

interface SidebarProps {
  sessions: ChatSession[];
  currentSessionId: string | null;
  generatingSessionIds?: string[];
  onSelectSession: (id: string) => void;
  /** 在快捷小窗口（Spotlight）中直接打开指定会话，不改变主窗口当前会话与滚动位置 */
  onOpenSessionInSpotlight?: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onOpenSettings: () => void;
  onOpenServiceManager: () => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  currentSessionId,
  generatingSessionIds = [],
  onSelectSession,
  onOpenSessionInSpotlight,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onOpenSettings,
  onOpenServiceManager,
  isOpen,
  onToggleOpen,
}) => {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  /** 会话条目右键菜单：仅提供「用小窗口打开」 */
  const [contextMenu, setContextMenu] = useState<{
    session: ChatSession;
    x: number;
    y: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);

  const openContextMenu = (session: ChatSession, e: React.MouseEvent) => {
    // 重命名输入框内保留浏览器/系统原生右键菜单（复制、粘贴）
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!onOpenSessionInSpotlight) return;
    // 菜单尺寸估算，用于把菜单钳制在视口内（右/下边缘不溢出）
    const menuWidth = 184;
    const menuHeight = 40;
    setContextMenu({
      session,
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8)),
    });
  };

  const startRename = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    if (generatingSessionIds.includes(session.id)) return;
    setEditingId(session.id);
    setEditingTitle(session.title);
  };

  const confirmRename = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (editingTitle.trim()) {
      onRenameSession(id, editingTitle.trim());
    }
    setEditingId(null);
  };

  const cancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
  };

  const {
    handleKeyDown: handleRenameKeyDown,
    handleCompositionStart: handleRenameCompStart,
    handleCompositionEnd: handleRenameCompEnd,
  } = useImeInput<HTMLInputElement>({
    onEnter: (e) => {
      if (editingId) {
        confirmRename(editingId, e as unknown as React.MouseEvent);
      }
    },
    onKeyDown: (e) => {
      if (e.key === 'Escape') {
        cancelRename(e as unknown as React.MouseEvent);
      }
    },
  });

  const query = searchQuery.trim().toLowerCase();
  const filteredSessions = query
    ? sessions.filter((s) => {
        if (s.title.toLowerCase().includes(query)) return true;
        return s.messages?.some(
          (m) => m.role === 'user' && m.content.toLowerCase().includes(query)
        );
      })
    : sessions;

  return (
    <aside
      data-left-sidebar="true"
      // 外层只负责「让出/收回 260px 空间」，内层是**固定 260 宽的整块**：
      // 开合时内层只做 translateX（合成层动画），内容一次都不重排 → 预载好整块滑入。
      className={`relative flex-shrink-0 h-full transition-[width] duration-200 ease-in-out select-none overflow-hidden ${
        isOpen ? 'w-[260px] min-w-[260px]' : 'w-0 min-w-0 pointer-events-none'
      }`}
    >
      <div
        data-sidebar-surface="true"
        className={`absolute left-0 top-0 flex h-full w-[260px] flex-col border-r border-black/5 bg-[#f1f3f6] transition-transform duration-200 ease-in-out dark:border-white/5 dark:bg-[#1a1b1f] ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
      {/* Top 52px Bar: Traffic lights (78px) + Empty drag space + Collapse Button */}
      <div className="h-[52px] flex items-center justify-between px-3 flex-shrink-0 select-none">
        {/* Left space reserved for native traffic lights (78px) */}
        <div className="w-[78px] h-full" />

        {/* Right tools in top bar: Collapse Sidebar Button */}
        <button
          onClick={onToggleOpen}
          data-sidebar-toggle="true"
          className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
          title={t('collapseSidebar')}
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* Brand Title (Matching Qianwen: Bold, large, clean)
          标题行右侧放两个入口：服务管理在左、设置在右（各占一格按钮宽，整体靠右）。
          hover 描述直接用各自弹窗的标题 key，改标题会自动跟随。 */}
      <div className="px-4 pt-1 pb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-[#1f2328] dark:text-[#f1f3f7]">
          SimpleUI
        </h1>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onOpenServiceManager}
            className="p-2 rounded-xl text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
            title={t('serviceManagerTitle')}
          >
            <Server className="w-4 h-4" />
          </button>
          <button
            onClick={onOpenSettings}
            className="p-2 rounded-xl text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
            title={t('settingsTitle')}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* New Chat Button (Qianwen Style: Large rounded card button) */}
      <div className="px-3 pb-2">
        <button
          onClick={onNewSession}
          className="w-full flex items-center justify-between py-2.5 px-3.5 rounded-xl bg-white hover:bg-[#e8ebf0] dark:bg-[#25262c] dark:hover:bg-[#2d2e35] active:scale-[0.99] text-[#1f2328] dark:text-[#f1f3f7] text-sm font-medium transition-all border border-black/5 dark:border-white/5 shadow-sm group"
        >
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-zinc-600 group-hover:text-zinc-900 dark:text-zinc-300 dark:group-hover:text-white transition-colors" />
            <span>{t('newChat')}</span>
          </div>
          <MessageSquarePlus className="w-4 h-4 text-zinc-400 group-hover:text-zinc-600 dark:text-zinc-500 dark:group-hover:text-zinc-300 transition-colors" />
        </button>
      </div>

      {/* Section Header: 最近对话 & 搜索按钮 (Placed right above history list) */}
      <div className="px-3.5 pt-3 pb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-500 dark:text-zinc-400 tracking-wide select-none">
        <span className="uppercase">{t('recentChats')}</span>
        <button
          onClick={() => setShowSearch(!showSearch)}
          className={`p-1 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors ${
            showSearch ? 'text-zinc-900 bg-black/5 dark:text-white dark:bg-white/10' : ''
          }`}
          title={t('searchTitle')}
        >
          <Search className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search Input (Collapsible, directly above history list) */}
      {showSearch && (
        <div className="px-3 pb-2 animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-2.5 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('searchChatsPlaceholder')}
              autoFocus
              className="w-full bg-white dark:bg-[#232429] text-xs text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 pl-8 pr-7 py-1.5 rounded-xl border border-black/10 dark:border-white/10 focus:outline-none focus:border-blue-500 dark:focus:border-zinc-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 text-zinc-400 hover:text-zinc-700 dark:hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Session List (Clean, modern Qianwen item styling) */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {filteredSessions.length === 0 ? (
          <div className="text-center py-12 text-xs text-zinc-500">
            {searchQuery ? t('noChatsFound') : t('noChatsYet')}
          </div>
        ) : (
          filteredSessions.map((session) => {
            const isSelected = session.id === currentSessionId;
            const isGeneratingSession = generatingSessionIds.includes(session.id);
            const isEditing = session.id === editingId && !isGeneratingSession;
            const isLastBlankSession =
              sessions.length <= 1 && (!session.messages || session.messages.length === 0);

            let matchedUserQuestion: string | null = null;
            if (query && !session.title.toLowerCase().includes(query)) {
              const userMsg = session.messages?.find(
                (m) => m.role === 'user' && m.content.toLowerCase().includes(query)
              );
              if (userMsg) {
                matchedUserQuestion = userMsg.content.trim();
              }
            }

            return (
              <div
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                onContextMenu={(e) => openContextMenu(session, e)}
                className={`group relative flex items-center justify-between px-3 py-2.5 rounded-xl text-xs cursor-pointer select-none outline-none transition-colors duration-150 border ${
                  isSelected
                    ? 'bg-white dark:bg-[#292a30] text-[#1f2328] dark:text-[#f1f3f7] font-medium shadow-sm dark:shadow-none border-black/5 dark:border-white/5'
                    : 'border-transparent text-zinc-600 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-[#212227]'
                }`}
              >
                <div className="truncate mr-2 flex-1 min-w-0">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={handleRenameKeyDown}
                      onCompositionStart={handleRenameCompStart}
                      onCompositionEnd={handleRenameCompEnd}
                      autoFocus
                      className="w-full bg-white dark:bg-[#1b1c20] text-zinc-900 dark:text-white px-2 py-0.5 rounded-lg border border-blue-500/80 focus:outline-none"
                    />
                  ) : (
                    <div>
                      <span className="truncate block font-medium">{session.title}</span>
                      {matchedUserQuestion && (
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate block mt-0.5">
                          💬 {t('matchedInQuery')}: {matchedUserQuestion}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Right Action: Spinning loader while generating; Edit & Delete Actions (hover only) when idle */}
                {isGeneratingSession ? (
                  <div
                    className="flex items-center justify-center p-1 text-blue-500 dark:text-blue-400 flex-shrink-0"
                    title={t('generating') || 'Generating...'}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  </div>
                ) : (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    {isEditing ? (
                      <>
                        <button
                          onClick={(e) => confirmRename(session.id, e)}
                          className="p-1 hover:text-emerald-500 dark:hover:text-emerald-400"
                          title={t('confirm')}
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={cancelRename}
                          className="p-1 hover:text-red-500 dark:hover:text-red-400"
                          title={t('cancel')}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={(e) => startRename(session, e)}
                          className="p-1 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors"
                          title={t('rename')}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        {!isLastBlankSession && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteSession(session.id);
                            }}
                            className="p-1 text-zinc-500 hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400 transition-colors"
                            title={t('deleteChat')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      </div>

      {contextMenu &&
        createPortal(
          <div
            ref={contextMenuRef}
            data-session-context-menu="true"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onContextMenu={(e) => e.preventDefault()}
            className="fixed z-[10000] min-w-[176px] p-1 rounded-xl bg-white/95 dark:bg-[#1e2025]/95 border border-black/10 dark:border-[#3a3d45] shadow-lg backdrop-blur-sm select-none"
          >
            <button
              type="button"
              onClick={() => {
                const sessionId = contextMenu.session.id;
                setContextMenu(null);
                onOpenSessionInSpotlight?.(sessionId);
              }}
              className="w-full flex items-center gap-2 px-2.5 h-8 rounded-lg text-left text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
            >
              <PictureInPicture2 className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{t('openSessionInSpotlight')}</span>
            </button>
          </div>,
          document.body
        )}
    </aside>
  );
};
