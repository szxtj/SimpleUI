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
 * Deletes media files on disk that are no longer referenced in any session.
 */
export async function deleteUnreferencedMedia(
  candidateUrlsOrFilenames: string[],
  remainingSessions: ChatSession[]
): Promise<void> {
  if (!candidateUrlsOrFilenames || candidateUrlsOrFilenames.length === 0) return;

  const activeSet = extractReferencedMedia(remainingSessions);
  const toDelete: string[] = [];

  for (const item of candidateUrlsOrFilenames) {
    if (!item) continue;
    const match = item.match(/\/api\/media\/([a-zA-Z0-9_\-\.]+)/);
    const filename = match ? match[1] : item;

    // Only delete if NOT referenced in any remaining session
    if (!activeSet.has(filename)) {
      toDelete.push(filename);
    }
  }

  if (toDelete.length === 0) return;

  try {
    const res = await fetch('/api/media/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: toDelete }),
    });
    if (res.ok) {
      console.log(`[mediaCleanup] Successfully deleted ${toDelete.length} orphaned media files`);
    }
  } catch (err) {
    console.warn('[mediaCleanup] Failed to delete media files from disk:', err);
  }
}

/**
 * Triggers background garbage collection of orphaned files on disk.
 */
export async function triggerMediaGC(
  sessions: ChatSession[],
  gracePeriodSeconds: number = 300
): Promise<void> {
  const activeSet = extractReferencedMedia(sessions);
  try {
    const res = await fetch('/api/media/gc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeFilenames: Array.from(activeSet),
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
