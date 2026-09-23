import React from 'react';
import { X } from 'lucide-react';

interface ImageAttachmentProps {
  images: string[];
  onRemove: (index: number) => void;
}

export const ImageAttachment: React.FC<ImageAttachmentProps> = ({ images, onRemove }) => {
  if (!images || images.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2.5 px-4 pt-3 pb-1 border-b border-[#2d2f35]">
      {images.map((imgUrl, idx) => (
        <div
          key={idx}
          className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[#3c3f47] bg-[#16171a] shadow-md flex-shrink-0"
        >
          <img
            src={imgUrl}
            alt={`attachment-${idx}`}
            className="w-full h-full object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(idx)}
            className="absolute top-1 right-1 p-0.5 rounded-full bg-black/75 text-white/90 hover:bg-red-500 transition-colors shadow"
            title="移除图片"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
