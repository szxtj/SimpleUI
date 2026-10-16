import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';

interface ImageAttachmentProps {
  images: string[];
  onRemove: (index: number) => void;
  onPreview?: (index: number) => void;
}

export const ImageAttachment: React.FC<ImageAttachmentProps> = ({ images, onRemove, onPreview }) => {
  const { t } = useI18n();
  if (!images || images.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2.5 px-4 pt-3 pb-2 border-b border-black/[0.06] dark:border-white/10">
      {images.map((imgUrl, idx) => (
        <div
          key={idx}
          onClick={() => onPreview?.(idx)}
          className={`relative group w-14 h-14 cq-md:w-16 cq-md:h-16 rounded-xl overflow-hidden border border-black/10 dark:border-white/10 bg-zinc-100/90 dark:bg-[#1a1b1e] shadow-xs flex-shrink-0 select-none ${
            onPreview ? 'cursor-zoom-in hover:opacity-90 active:scale-[0.98] transition-all' : ''
          }`}
        >
          <img
            src={imgUrl}
            alt={`attachment-${idx}`}
            draggable={false}
            className="w-full h-full object-cover select-none pointer-events-none"
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(idx);
            }}
            className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/60 hover:bg-red-500 text-white flex items-center justify-center transition-colors shadow-xs cursor-pointer z-10"
            title={t('removeImage')}
          >
            <X className="w-2.5 h-2.5 stroke-[2.5]" />
          </button>
        </div>
      ))}
    </div>
  );
};
