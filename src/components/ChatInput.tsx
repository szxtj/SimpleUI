import React, { useRef, useEffect, useState } from 'react';
import { ArrowUp, Plus, Square, Zap, Brain } from 'lucide-react';
import { useI18n } from '../i18n';
import { ContextRing } from './ContextRing';
import { ImageAttachment } from './ImageAttachment';
import { extractImagesFromPaste, fileToDataURL } from '../utils/image';

interface ChatInputProps {
  input: string;
  setInput: (val: string) => void;
  images: string[];
  setImages: React.Dispatch<React.SetStateAction<string[]>>;
  isGenerating: boolean;
  onSend: () => void;
  onStop: () => void;
  usedTokens: number;
  maxContext: number;
  enableThinking: boolean;
  setEnableThinking: (val: boolean) => void;
  visionReady: boolean;
  hasMessages?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  input,
  setInput,
  images,
  setImages,
  isGenerating,
  onSend,
  onStop,
  usedTokens,
  maxContext,
  enableThinking,
  setEnableThinking,
  visionReady,
  hasMessages = false,
}) => {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = `${Math.min(Math.max(scrollHeight, 26), 200)}px`;
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating && (input.trim() || images.length > 0)) {
        onSend();
      }
    }
  };

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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length > 0) {
      try {
        const urls = await Promise.all(files.map(fileToDataURL));
        setImages((prev) => [...prev, ...urls]);
      } catch (err) {
        console.error('Failed to drop image:', err);
      }
    }
  };

  return (
    <div
      className={`relative w-full rounded-[24px] border transition-all duration-200 bg-white dark:bg-[#25262c] shadow-lg dark:shadow-xl ${
        isDragging
          ? 'border-blue-500 bg-blue-50/50 dark:bg-[#292b33]'
          : 'border-black/10 dark:border-white/10 focus-within:border-black/20 dark:focus-within:border-white/20'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input for image upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/heic,image/heif,image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Image attachments preview pill */}
      <ImageAttachment
        images={images}
        onRemove={(idx) =>
          setImages((prev) => prev.filter((_, i) => i !== idx))
        }
      />

      {/* Main Textarea */}
      <div className="px-4 pt-3.5 pb-1">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={hasMessages ? t('placeholderFollowUp') : t('placeholderInitial')}
          rows={1}
          className="w-full bg-transparent resize-none text-[15px] text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed max-h-[200px]"
        />
      </div>

      {/* Bottom Control Toolbar */}
      <div className="flex items-center justify-between px-3.5 pb-2.5 pt-1 select-none">
        {/* Left: ONLY Attachment button + Quick/Thinking Dual-mode switch */}
        <div className="flex items-center gap-2">
          {/* Add Attachment Button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
              images.length > 0
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-black/5 hover:bg-black/10 text-zinc-600 hover:text-black dark:bg-white/5 dark:hover:bg-white/10 dark:text-zinc-300 dark:hover:text-white'
            }`}
            title={visionReady ? t('attachImage') : t('attachImageReady')}
          >
            <Plus className="w-4 h-4 stroke-[2.5]" />
          </button>

          {/* Quick / Thinking Direct Toggle Button */}
          <button
            type="button"
            onClick={() => setEnableThinking(!enableThinking)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all active:scale-95 border ${
              enableThinking
                ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-950/70 dark:text-blue-300 dark:border-blue-500/40 dark:hover:bg-blue-900/80 shadow-sm'
                : 'bg-black/5 text-zinc-600 border-black/5 hover:bg-black/10 hover:text-black dark:bg-white/5 dark:text-zinc-300 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white'
            }`}
            title={enableThinking ? t('thinkingOnTooltip') : t('thinkingOffTooltip')}
          >
            {enableThinking ? (
              <>
                <Brain className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                <span>{t('thinkingOn')}</span>
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                <span>{t('thinkingOff')}</span>
              </>
            )}
          </button>
        </div>

        {/* Right: Send Button + Context Ring on its RIGHT */}
        <div className="flex items-center gap-2">
          {/* Send / Stop Button */}
          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              className="w-8 h-8 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-transform active:scale-95 shadow-md"
              title={t('stop')}
            >
              <Square className="w-3.5 h-3.5 fill-white" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!input.trim() && images.length === 0}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                input.trim() || images.length > 0
                  ? 'bg-zinc-900 hover:bg-black text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-black shadow-md active:scale-95'
                  : 'bg-zinc-200 text-zinc-400 dark:bg-[#35363d] dark:text-zinc-500 cursor-not-allowed'
              }`}
              title={t('send')}
            >
              <ArrowUp className="w-4 h-4 stroke-[2.5]" />
            </button>
          )}

          {/* Context Ring RIGHT NEXT TO (to the right of) Send Icon */}
          <ContextRing usedTokens={usedTokens} maxContext={maxContext} />
        </div>
      </div>
    </div>
  );
};
