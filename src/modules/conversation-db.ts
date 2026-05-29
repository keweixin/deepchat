/**
 * Conversation Message Store — IndexedDB persistence for conversation messages
 *
 * Separates heavy message payloads from lightweight metadata storage
 * (localStorage / JSON file), eliminating full-serialization stalls.
 *
 * Design:
 * - Metadata (title, timestamps, settings) → client-store (localStorage/JSON)
 * - Messages (potentially large arrays)    → IndexedDB (this module)
 */

const DB_NAME = 'DeepChatConversations';
const DB_VERSION = 1;
const STORE_MESSAGES = 'messages';

let _dbPromise: Promise<IDBDatabase | null> | null = null;

function getDB(): Promise<IDBDatabase | null> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => {
        console.warn('[ConversationDB] IndexedDB open failed:', req.error?.message);
        _dbPromise = null;
        resolve(null);
      };
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          db.createObjectStore(STORE_MESSAGES, { keyPath: 'conversationId' });
        }
      };
    } catch (err: any) {
      console.warn('[ConversationDB] IndexedDB unavailable:', err?.message);
      _dbPromise = null;
      resolve(null);
    }
  });
  return _dbPromise;
}

/** Load messages for a single conversation */
export async function loadMessages(conversationId: string): Promise<any[]> {
  try {
    const db = await getDB();
    if (!db) return [];
    return new Promise<any[]>((resolve) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const req = store.get(conversationId);
      req.onsuccess = () => {
        const result = req.result;
        resolve(Array.isArray(result?.messages) ? result.messages : []);
      };
      req.onerror = () => resolve([]);
    });
  } catch (err) {
    console.warn('[ConversationDB] loadMessages failed:', (err as Error).message);
    return [];
  }
}

/** Save messages for a single conversation */
export async function saveMessages(conversationId: string, messages: any[]): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      const req = store.put({ conversationId, messages: Array.isArray(messages) ? messages : [] });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[ConversationDB] saveMessages failed:', (err as Error).message);
  }
}

/** Delete messages for a single conversation */
export async function deleteMessages(conversationId: string): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      const req = store.delete(conversationId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[ConversationDB] deleteMessages failed:', (err as Error).message);
  }
}

/** Load all messages keyed by conversationId */
export async function loadAllMessages(): Promise<Record<string, any[]>> {
  try {
    const db = await getDB();
    if (!db) return {};
    return new Promise<Record<string, any[]>>((resolve) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const req = store.openCursor();
      const result: Record<string, any[]> = {};
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const value = cursor.value;
          if (value?.conversationId && Array.isArray(value.messages)) {
            result[value.conversationId] = value.messages;
          }
          cursor.continue();
        } else {
          resolve(result);
        }
      };
      req.onerror = () => resolve(result);
    });
  } catch (err) {
    console.warn('[ConversationDB] loadAllMessages failed:', (err as Error).message);
    return {};
  }
}

/** Batch-save messages for multiple conversations in one transaction */
export async function saveAllMessages(
  entries: Array<{ conversationId: string; messages: any[] }>
): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      for (const entry of entries) {
        store.put({
          conversationId: entry.conversationId,
          messages: Array.isArray(entry.messages) ? entry.messages : [],
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[ConversationDB] saveAllMessages failed:', (err as Error).message);
  }
}

/** Clear all conversation messages from IndexedDB */
export async function clearAllMessages(): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[ConversationDB] clearAllMessages failed:', (err as Error).message);
  }
}
