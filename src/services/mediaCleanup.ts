import { ChatSession } from '../types/chat';

/**
 * Extracts all referenced media filenames from all messages in the provided sessions.
 */
export function extractReferencedMedia(sessions: ChatSession[]): Set<string> {
  const referenced = new Set<string>();
  for (const session of sessions) {
    if (!session.messages) continue;
    for (const msg of session.messages) {
      if (!msg.images || msg.images.length === 0) continue;
      for (const imgUrl of msg.images) {
        const match = imgUrl.match(/\/api\/media\/([a-zA-Z0-9_\-\.]+)/);
        if (match) {
          referenced.add(match[1]);
        }
      }
    }
  }
  return referenced;
}

/**
 * Requests the server to delete candidate media files if and only if they are no longer
 * referenced by any server session or any remaining draft attachments in the input box.
 *
 * Note: The backend MediaService automatically checks all authoritative server sessions
 * before deleting any file on disk.
 */
export async function deleteUnreferencedMedia(
  candidateUrlsOrFilenames: string[],
  remainingDraftUrlsOrSessions: string[] | ChatSession[] = []
): Promise<void> {
  if (!candidateUrlsOrFilenames || candidateUrlsOrFilenames.length === 0) return;

  const protectedUrls: string[] = [];
  if (Array.isArray(remainingDraftUrlsOrSessions) && remainingDraftUrlsOrSessions.length > 0) {
    const first = remainingDraftUrlsOrSessions[0];
    if (typeof first === 'string') {
      protectedUrls.push(...(remainingDraftUrlsOrSessions as string[]));
    } else {
      const refs = extractReferencedMedia(remainingDraftUrlsOrSessions as ChatSession[]);
      protectedUrls.push(...Array.from(refs));
    }
  }

  const protectedFilenames = new Set<string>();
  for (const item of protectedUrls) {
    if (!item) continue;
    const match = item.match(/\/api\/media\/([a-zA-Z0-9_\-\.]+)/);
    protectedFilenames.add(match ? match[1] : item);
  }

  const toDelete: string[] = [];
  for (const item of candidateUrlsOrFilenames) {
    if (!item) continue;
    const match = item.match(/\/api\/media\/([a-zA-Z0-9_\-\.]+)/);
    const filename = match ? match[1] : item;
    if (!protectedFilenames.has(filename)) {
      toDelete.push(filename);
    }
  }

  if (toDelete.length === 0) return;

  try {
    const res = await fetch('/api/media/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filenames: toDelete,
        protectedUrls: Array.from(protectedFilenames),
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.deleted) && data.deleted.length > 0) {
        console.log(`[mediaCleanup] Deleted ${data.deleted.length} unreferenced draft media file(s)`);
      }
    }
  } catch (err) {
    console.warn('[mediaCleanup] Failed to delete media files from disk:', err);
  }
}

/** 媒体目录的磁盘占用（orphan* = 未被任何会话引用、可以清理的部分） */
export interface MediaStorageStats {
  mediaDir: string;
  fileCount: number;
  totalBytes: number;
  totalMB: string;
  orphanCount: number;
  orphanBytes: number;
  orphanMB: string;
}

export async function getMediaStats(): Promise<MediaStorageStats | null> {
  try {
    const res = await fetch('/api/media/stats', { cache: 'no-store' });
    if (res.ok) return (await res.json()) as MediaStorageStats;
  } catch (err) {
    console.warn('[mediaCleanup] Failed to read media stats:', err);
  }
  return null;
}

/** 在访达里打开媒体目录 */
export async function openMediaDir(): Promise<boolean> {
  try {
    const res = await fetch('/api/media/open-dir', { method: 'POST' });
    if (res.ok) return true;
  } catch (err) {
    console.warn('[mediaCleanup] Failed to open media folder:', err);
  }
  return false;
}

/**
 * 清理磁盘上不再被任何会话引用的图片。
 *
 * 只会由用户在设置里手动点「清理未使用图片」触发 —— **没有**任何自动调用方：
 * 不随启动、不随定时器、不随删除草稿运行。服务端还会再用权威会话列表做一次保护，
 * 因此被引用的图片不可能被这条路径删掉。
 */
export async function triggerMediaGC(
  gracePeriodSeconds: number = 0
): Promise<{ deletedCount: number; freedMB: string } | null> {
  try {
    const res = await fetch('/api/media/gc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gracePeriodSeconds }),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        deletedCount: Number(data?.deletedCount) || 0,
        freedMB: String(data?.freedMB ?? '0'),
      };
    }
  } catch (err) {
    console.warn('[mediaCleanup] Media cleanup request failed:', err);
  }
  return null;
}
