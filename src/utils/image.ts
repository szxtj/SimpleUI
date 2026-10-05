/**
 * Utilities for formatting, validating, and persisting images
 * to SimpleUI's local media asset storage (/api/media/...).
 * 
 * Preserves 100% full original resolution and fidelity for multimodal models.
 * Never downsamples or uses lossy compression.
 */

/**
 * Converts image formats unsupported by certain local LLM vision engines
 * (such as WebP or BMP) to lossless PNG, strictly preserving original width and height.
 */
async function convertToLosslessPng(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');

        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);

        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas toBlob conversion failed'));
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for lossless PNG conversion'));
    };

    img.src = url;
  });
}

/**
 * Reads a File into a raw, uncompressed Base64 Data URL (offline / error fallback).
 */
function readAsRawDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('FileReader did not return string'));
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads a raw image file directly to the local disk media store (/api/media/upload).
 * Preserves 100% full original resolution and fidelity (NO downscaling, NO quality loss).
 * Returns the content-addressed URL pointer (e.g. `/api/media/<hash>.png`).
 */
export async function uploadMediaFile(file: File): Promise<string> {
  let fileToUpload: Blob = file;
  let filename = file.name || 'image.png';

  const type = (file.type || '').toLowerCase();
  // If the browser provides a format like webp or bmp that upstream engines may reject,
  // losslessly convert to PNG while preserving 100% original dimensions.
  if (type === 'image/webp' || type === 'image/bmp') {
    try {
      fileToUpload = await convertToLosslessPng(file);
      filename = filename.replace(/\.[^.]+$/, '.png');
    } catch (e) {
      console.warn('[image] Lossless PNG conversion failed, uploading original file:', e);
      fileToUpload = file;
    }
  }

  try {
    const res = await fetch('/api/media/upload', {
      method: 'POST',
      headers: {
        'Content-Type': fileToUpload.type || 'application/octet-stream',
        'X-Original-Filename': encodeURIComponent(filename),
      },
      body: fileToUpload,
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.url) {
        return data.url;
      }
    }
  } catch (err) {
    console.warn('[image] Upload to /api/media/upload failed, falling back to data URL:', err);
  }

  // Fallback: full uncompressed Data URL
  return readAsRawDataURL(fileToUpload);
}

/**
 * Uploads a Base64 Data URL to the local media store (/api/media/upload).
 */
export async function uploadDataUrl(dataUrl: string, filename?: string): Promise<string> {
  if (!dataUrl.startsWith('data:')) return dataUrl;

  try {
    const res = await fetch('/api/media/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: dataUrl, filename }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.url) {
        return data.url;
      }
    }
  } catch (err) {
    console.warn('[image] Uploading data URL to media store failed:', err);
  }

  return dataUrl;
}

/**
 * Backward compatibility alias: all input handlers (paste, drag-drop, file select)
 * automatically use uploadMediaFile to save images to local media disk.
 */
export const fileToDataURL = uploadMediaFile;

export function extractImagesFromPaste(e: React.ClipboardEvent | ClipboardEvent): File[] {
  const files: File[] = [];
  if (!e.clipboardData) return files;
  
  const items = e.clipboardData.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.indexOf('image') !== -1) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Checks whether a dropped or pasted file is a valid image,
 * supporting both MIME inspection and common image extensions (including HEIC/WEBP).
 */
export function isImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  const name = (file.name || '').toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|heic|heif|svg)$/i.test(name);
}
