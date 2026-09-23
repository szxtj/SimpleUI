/**
 * Utilities for formatting, validating, and converting images to
 * TurboFieldfareServer-compliant base64 Data URLs.
 * 
 * TurboFieldfareServer strictly allows:
 * - data:image/jpeg;base64,...
 * - data:image/png;base64,...
 * - data:image/heic;base64,...
 * - data:image/heif;base64,...
 */

export async function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // If it's already JPEG, PNG, or HEIC, read directly
    const validMimes = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];
    
    if (validMimes.includes(file.type.toLowerCase())) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to read image as data URL'));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('File read error'));
      reader.readAsDataURL(file);
    } else {
      // For webp, bmp, gif, or other formats, convert to PNG via Canvas
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          // Scale down if extremely large
          const MAX_DIM = 2048;
          if (width > MAX_DIM || height > MAX_DIM) {
            if (width > height) {
              height = Math.round((height * MAX_DIM) / width);
              width = MAX_DIM;
            } else {
              width = Math.round((width * MAX_DIM) / height);
              height = MAX_DIM;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas 2D context unavailable');
          
          ctx.drawImage(img, 0, 0, width, height);
          const pngDataUrl = canvas.toDataURL('image/png');
          URL.revokeObjectURL(url);
          resolve(pngDataUrl);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image for conversion'));
      };
      img.src = url;
    }
  });
}

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
