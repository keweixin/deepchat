/**
 * Agent Trace Store — IndexedDB persistence for trace records
 *
 * Features:
 * - Store traces by runId with conversationId index
 * - Query traces by conversation, time range, or status
 * - Automatic cleanup of old traces (configurable retention)
 * - Export/import for debugging and sharing
 */

const DB_NAME = 'DeepChatAgentTraces';
const DB_VERSION = 1;
const STORE_NAME = 'traces';
const STORE_RUNS = 'runs';

let _dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      // Store: individual trace events
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'eventId' });
        store.createIndex('runId', 'runId', { unique: false });
        store.createIndex('conversationId', 'conversationId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }
      // Store: run summaries (for fast listing without loading all events)
      if (!db.objectStoreNames.contains(STORE_RUNS)) {
        const runStore = db.createObjectStore(STORE_RUNS, { keyPath: 'runId' });
        runStore.createIndex('conversationId', 'conversationId', { unique: false });
        runStore.createIndex('startedAt', 'startedAt', { unique: false });
        runStore.createIndex('status', 'status', { unique: false });
      }
    };
  });
  return _dbPromise;
}

// ─── Write Operations ───────────────────────────────────────────────────────

/**
 * Save a complete trace (all events + run summary) to IndexedDB.
 */
export async function saveTrace(recorder: Record<string, any>, conversationId: string) {
  if (!recorder || !recorder.runId) return;
  const db = await getDB();

  // Save run summary
  const runSummary = {
    ...recorder.toRunSummary(),
    runId: recorder.runId,
    conversationId: conversationId || '',
    savedAt: Date.now(),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS], 'readwrite');
    const store = tx.objectStore(STORE_RUNS);
    const req = store.put(runSummary);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  // Save all events
  const events = recorder.events.map((e: Record<string, any>) => ({
    ...e,
    runId: recorder.runId,
    conversationId: conversationId || '',
    savedAt: Date.now(),
  }));

  if (events.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let completed = 0;
      let failed = false;
      for (const event of events) {
        const req = store.put(event);
        req.onsuccess = () => {
          completed++;
          if (completed === events.length) resolve();
        };
        req.onerror = () => {
          if (!failed) {
            failed = true;
            reject(req.error);
          }
        };
      }
      if (events.length === 0) resolve();
    });
  }
}

/**
 * Save a single trace event (for incremental streaming updates).
 */
export async function saveTraceEvent(event: Record<string, any>, runId: string, conversationId: string) {
  if (!event || !runId) return;
  const db = await getDB();
  const record = {
    ...event,
    runId,
    conversationId: conversationId || '',
    savedAt: Date.now(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── Read Operations ────────────────────────────────────────────────────────

/**
 * Load all events for a given runId.
 */
export async function loadTraceEvents(runId: string) {
  if (!runId) return [];
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('runId');
    const req = index.getAll(runId);
    req.onsuccess = () => {
      const events = req.result || [];
      events.sort((a, b) => a.timestamp - b.timestamp);
      resolve(events);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Load run summary for a given runId.
 */
export async function loadRunSummary(runId: string) {
  if (!runId) return null;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS], 'readonly');
    const store = tx.objectStore(STORE_RUNS);
    const req = store.get(runId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * List all runs for a conversation.
 */
export async function listRunsForConversation(conversationId: string, options: Record<string, any> = {}) {
  if (!conversationId) return [];
  const { limit = 50, offset = 0 } = options;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS], 'readonly');
    const store = tx.objectStore(STORE_RUNS);
    const index = store.index('conversationId');
    const req = index.openCursor(conversationId, 'prev'); // newest first
    const results: Record<string, any>[] = [];
    let skipped = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      if (skipped < offset) {
        skipped++;
        cursor.continue();
        return;
      }
      results.push(cursor.value);
      if (results.length >= limit) {
        resolve(results);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * List all runs (global, for admin/debug).
 */
export async function listAllRuns(options: Record<string, any> = {}) {
  const { limit = 100, status, since, until } = options;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS], 'readonly');
    const store = tx.objectStore(STORE_RUNS);
    const index = store.index('startedAt');
    const req = index.openCursor(null, 'prev');
    const results: Record<string, any>[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      const run = cursor.value;
      if (status && run.status !== status) {
        cursor.continue();
        return;
      }
      if (since && run.startedAt < since) {
        resolve(results);
        return;
      }
      if (until && run.startedAt > until) {
        cursor.continue();
        return;
      }
      results.push(run);
      if (results.length >= limit) {
        resolve(results);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── Delete Operations ──────────────────────────────────────────────────────

/**
 * Delete a single run and all its events.
 */
export async function deleteTrace(runId: string) {
  if (!runId) return;
  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS, STORE_NAME], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);

    // Delete run summary
    tx.objectStore(STORE_RUNS).delete(runId);

    // Delete all events for this run
    const eventStore = tx.objectStore(STORE_NAME);
    const index = eventStore.index('runId');
    const req = index.openCursor(runId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        eventStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
}

/**
 * Delete all traces for a conversation.
 */
export async function deleteTracesForConversation(conversationId: string) {
  if (!conversationId) return;
  const runs = (await listRunsForConversation(conversationId, { limit: 9999 })) as any[];
  for (const run of runs) {
    await deleteTrace(run.runId);
  }
}

/**
 * Clean up old traces beyond retention period.
 * @param {number} retentionDays — default 30 days
 */
export async function cleanupOldTraces(retentionDays = 30) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const db = await getDB();
  const runsToDelete: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS], 'readonly');
    const store = tx.objectStore(STORE_RUNS);
    const index = store.index('startedAt');
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      const run = cursor.value;
      if (run.startedAt < cutoff) {
        runsToDelete.push(run.runId);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  for (const runId of runsToDelete) {
    await deleteTrace(runId);
  }
  return runsToDelete.length;
}

// ─── Storage Stats ──────────────────────────────────────────────────────────

export async function getTraceStoreStats() {
  const db = await getDB();
  const stats = { runs: 0, events: 0, oldestRun: 0, newestRun: 0 };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS], 'readonly');
    const store = tx.objectStore(STORE_RUNS);
    const req = store.count();
    req.onsuccess = () => {
      stats.runs = req.result;
      resolve();
    };
    req.onerror = () => reject(req.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => {
      stats.events = req.result;
      resolve();
    };
    req.onerror = () => reject(req.error);
  });

  return stats;
}

// ─── Export / Import ────────────────────────────────────────────────────────

/**
 * Export all traces as a JSON blob (for backup or debugging).
 */
export async function exportAllTraces() {
  const db = await getDB();
  const runs: any[] = [];
  const events: any[] = [];

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS], 'readonly');
    const store = tx.objectStore(STORE_RUNS);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      runs.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      events.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  const data = { version: 1, exportedAt: Date.now(), runs, events };
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

/**
 * Clear the entire trace store (nuclear option).
 */
export async function clearAllTraces() {
  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_RUNS, STORE_NAME], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_RUNS).clear();
    tx.objectStore(STORE_NAME).clear();
  });
}

// ─── Settings Integration ───────────────────────────────────────────────────

/**
 * Get trace retention setting from app settings.
 * Returns retention in days, or 0 for unlimited.
 */
export function resolveTraceRetention(settings: Record<string, any> = {}) {
  const val = settings.traceRetentionDays;
  if (val === 'unlimited' || val === 0 || val === '0') return 0;
  const num = Number(val);
  if (Number.isFinite(num) && num > 0) return num;
  return 30; // default
}

/**
 * Check if trace recording is enabled.
 */
export function isTraceRecordingEnabled(settings: Record<string, any> = {}) {
  return settings.enableTraceRecording !== false;
}
