import React, { useState } from 'react';
import { ChatSession, ServerHealthInfo } from '../types/chat';
import { useI18n } from '../i18n';
import {
  Plus,
  Trash2,
  Settings,
  Edit2,
  Check,
  X,
  Search,
  MessageSquarePlus,
  PanelLeftClose,
} from 'lucide-react';

interface SidebarProps {
  sessions: ChatSession[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onOpenSettings: () => void;
  healthInfo: ServerHealthInfo;
  isOpen: boolean;
  onToggleOpen: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onOpenSettings,
  healthInfo,
  isOpen,
  onToggleOpen,
}) => {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const startRename = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
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

  const filteredSessions = searchQuery.trim()
    ? sessions.filter((s) =>
        s.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : sessions;

  return (
    <aside
      className={`fixed lg:static top-0 bottom-0 left-0 z-40 bg-[#f1f3f6] dark:bg-[#1a1b1f] border-r border-black/5 dark:border-white/5 flex flex-col transition-all duration-200 ease-in-out select-none overflow-hidden ${
        isOpen
          ? 'w-[260px] min-w-[260px] opacity-100'
          : 'w-0 min-w-0 opacity-0 pointer-events-none border-r-0'
      }`}
    >
      {/* Top 52px Bar: Traffic lights (78px) + Empty drag space + Collapse Button */}
      <div className="h-[52px] flex items-center justify-between px-3 flex-shrink-0 select-none">
        {/* Left space reserved for native traffic lights (78px) */}
        <div className="w-[78px] h-full" />

        {/* Right tools in top bar: Collapse Sidebar Button */}
        <button
          onClick={onToggleOpen}
          className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
          title={t('collapseSidebar')}
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* Brand Title (Matching Qianwen: Bold, large, clean) */}
      <div className="px-4 pt-1 pb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-[#1f2328] dark:text-[#f1f3f7]">
          SimpleUI
        </h1>
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
            const isEditing = session.id === editingId;
            const isLastBlankSession =
              sessions.length <= 1 && (!session.messages || session.messages.length === 0);

            return (
              <div
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                className={`group relative flex items-center justify-between px-3 py-2.5 rounded-xl text-xs cursor-pointer transition-all duration-150 ${
                  isSelected
                    ? 'bg-white dark:bg-[#292a30] text-[#1f2328] dark:text-[#f1f3f7] font-medium shadow-sm border border-black/5 dark:border-transparent'
                    : 'text-zinc-600 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-[#212227]'
                }`}
              >
                <div className="truncate mr-2 flex-1">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')
                          confirmRename(session.id, e as unknown as React.MouseEvent);
                        if (e.key === 'Escape')
                          cancelRename(e as unknown as React.MouseEvent);
                      }}
                      autoFocus
                      className="w-full bg-white dark:bg-[#1b1c20] text-zinc-900 dark:text-white px-2 py-0.5 rounded-lg border border-blue-500/80 focus:outline-none"
                    />
                  ) : (
                    <span className="truncate block">{session.title}</span>
                  )}
                </div>

                {/* Edit & Delete Actions (hover only) */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
              </div>
            );
          })
        )}
      </div>

      {/* Footer: User / Service Status & Settings */}
      <div className="p-3 border-t border-black/5 dark:border-white/5 bg-[#eaecef] dark:bg-[#17181c] flex items-center justify-between">
        {/* Status indicator: "本地服务"大写在上，"就绪"小写在下 */}
        <div className="flex items-center gap-2.5 px-1 min-w-0">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              healthInfo.online
                ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]'
                : 'bg-red-400'
            }`}
          />
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-[#1f2328] dark:text-[#f1f3f7] leading-none truncate">
              {t('localService')}
            </span>
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1 leading-none truncate max-w-[150px]">
              {healthInfo.online ? t('statusReady') : t('statusOffline')}
            </span>
          </div>
        </div>

        {/* Settings button */}
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-xl text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
          title={t('settings')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
