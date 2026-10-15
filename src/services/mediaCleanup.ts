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

/**
 * Triggers background garbage collection of orphaned files on disk.
 * Server-side MediaService automatically protects all files referenced by active sessions.
 */
export async function triggerMediaGC(
  extraProtectedUrls: string[] = [],
  gracePeriodSeconds: number = 300
): Promise<void> {
  try {
    const res = await fetch('/api/media/gc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeFilenames: extraProtectedUrls,
        gracePeriodSeconds,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.deletedCount > 0) {
        console.log(`[mediaCleanup] GC cleaned up ${data.deletedCount} orphaned files (${data.freedMB} MB freed)`);
      }
    }
  } catch (err) {
    console.warn('[mediaCleanup] Media GC request failed:', err);
  }
}
