/**
 * IndexedDB storage for chat image attachments.
 *
 * LocalStorage has a strict 5MB quota in WebKit.
 * IndexedDB provides large persistent storage (hundreds of megabytes to gigabytes),
 * shared across all WKWebView windows belonging to the same origin.
 */

const DB_NAME = 'SimpleUI_Storage';
const DB_VERSION = 1;
const STORE_NAME = 'images';

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB is not supported'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

export async function saveImageToDB(key: string, dataUrl: string): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(dataUrl, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[imageStore] Failed to save image to IndexedDB:', e);
  }
}

export async function getImageFromDB(key: string): Promise<string | null> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[imageStore] Failed to get image from IndexedDB:', e);
    return null;
  }
}

export async function getImagesFromDB(keys: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (keys.length === 0) return result;
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let count = 0;
      for (const k of keys) {
        const req = store.get(k);
        req.onsuccess = () => {
          if (req.result) result[k] = req.result;
          count++;
          if (count === keys.length) resolve(result);
        };
        req.onerror = () => {
          count++;
          if (count === keys.length) resolve(result);
        };
      }
    });
  } catch {
    return result;
  }
}

export async function deleteImagesFromDB(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const k of keys) {
      store.delete(k);
    }
  } catch (e) {
    console.warn('[imageStore] Failed to delete images from IndexedDB:', e);
  }
}
