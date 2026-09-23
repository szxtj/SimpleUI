import React, { useState } from 'react';
import { ChatSession, ServerHealthInfo } from '../types/chat';
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
      className={`fixed lg:static top-0 bottom-0 left-0 z-40 bg-[#1a1b1f] border-r border-white/5 flex flex-col transition-all duration-200 ease-in-out select-none overflow-hidden ${
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
          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
          title="收起边栏"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* Brand Title (Matching Qianwen: Bold, large, clean) */}
      <div className="px-4 pt-1 pb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-[#f1f3f7]">
          SimpleUI
        </h1>
      </div>

      {/* New Chat Button (Qianwen Style: Large rounded dark card button) */}
      <div className="px-3 pb-2">
        <button
          onClick={onNewSession}
          className="w-full flex items-center justify-between py-2.5 px-3.5 rounded-xl bg-[#25262c] hover:bg-[#2d2e35] active:scale-[0.99] text-[#f1f3f7] text-sm font-medium transition-all border border-white/5 shadow-sm group"
        >
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-zinc-300 group-hover:text-white transition-colors" />
            <span>新对话</span>
          </div>
          <MessageSquarePlus className="w-4 h-4 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
        </button>
      </div>

      {/* Section Header: 最近对话 & 搜索按钮 (Placed right above history list) */}
      <div className="px-3.5 pt-3 pb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-400 tracking-wide select-none">
        <span className="uppercase">最近对话</span>
        <button
          onClick={() => setShowSearch(!showSearch)}
          className={`p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/5 transition-colors ${
            showSearch ? 'text-white bg-white/10' : ''
          }`}
          title="搜索历史记录"
        >
          <Search className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search Input (Collapsible, directly above history list) */}
      {showSearch && (
        <div className="px-3 pb-2 animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-2.5 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索历史记录..."
              autoFocus
              className="w-full bg-[#232429] text-xs text-[#f1f3f7] placeholder-zinc-500 pl-8 pr-7 py-1.5 rounded-xl border border-white/10 focus:outline-none focus:border-zinc-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 text-zinc-400 hover:text-white"
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
            {searchQuery ? '未找到相关对话' : '暂无对话记录'}
          </div>
        ) : (
          filteredSessions.map((session) => {
            const isSelected = session.id === currentSessionId;
            const isEditing = session.id === editingId;

            return (
              <div
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                className={`group relative flex items-center justify-between px-3 py-2.5 rounded-xl text-xs cursor-pointer transition-all duration-150 ${
                  isSelected
                    ? 'bg-[#292a30] text-[#f1f3f7] font-medium shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#212227]'
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
                      className="w-full bg-[#1b1c20] text-white px-2 py-0.5 rounded-lg border border-blue-500/80 focus:outline-none"
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
                        className="p-1 hover:text-emerald-400"
                        title="确认"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={cancelRename}
                        className="p-1 hover:text-red-400"
                        title="取消"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={(e) => startRename(session, e)}
                        className="p-1 text-zinc-400 hover:text-white transition-colors"
                        title="重命名"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(session.id);
                        }}
                        className="p-1 text-zinc-400 hover:text-red-400 transition-colors"
                        title="删除对话"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer: User / Service Status & Settings */}
      <div className="p-3 border-t border-white/5 bg-[#17181c] flex items-center justify-between">
        {/* Status indicator */}
        <div className="flex items-center gap-2 px-1">
          <span
            className={`w-2 h-2 rounded-full ${
              healthInfo.online
                ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                : 'bg-red-400'
            }`}
          />
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-medium text-[#f1f3f7] leading-none">
              SimpleUI
            </span>
            <span className="text-[10px] text-zinc-400 mt-1 leading-none truncate max-w-[150px]">
              {healthInfo.online
                ? `${healthInfo.modelId || '本地服务'} · 服务就绪`
                : '服务未连接'}
            </span>
          </div>
        </div>

        {/* Settings button */}
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
          title="模型参数与设置"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
