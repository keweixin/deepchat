import fs from 'fs';
import path from 'path';
import { cloneJob, type JobStore, type ToolJob } from './job-runtime.js';

type SqliteJobStoreOptions = {
  fallbackPath?: string;
  createDatabase?: (dbPath: string) => any;
  onFallback?: (reason: string) => void;
};

export function createJsonJobStore(filePath: string): JobStore {
  function readJobs(): ToolJob[] {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isToolJobLike);
      if (Array.isArray(parsed?.jobs)) return parsed.jobs.filter(isToolJobLike);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('[job-runtime] Failed to read JSON job store:', normalizeError(error));
      }
    }
    return [];
  }

  function writeJobs(jobs: ToolJob[]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ jobs }, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  }

  return {
    loadJobs() {
      return readJobs();
    },
    saveJob(job: ToolJob) {
      const jobs = readJobs().filter((item) => item.id !== job.id);
      jobs.unshift(cloneJob(job));
      writeJobs(jobs);
    },
    deleteJob(id: string) {
      writeJobs(readJobs().filter((job) => job.id !== id));
    },
  };
}

export function createSqliteJobStore(dbPath: string, options: SqliteJobStoreOptions = {}): JobStore {
  let db: any = null;
  let fallbackStore: JobStore | null = null;

  function activateFallback(error: unknown): JobStore {
    if (!fallbackStore) {
      const fallbackReason = normalizeError(error);
      fallbackStore = createJsonJobStore(options.fallbackPath || path.join(path.dirname(dbPath), 'deepchat-jobs.json'));
      options.onFallback?.(fallbackReason);
      console.warn('[job-runtime] SQLite job store unavailable, using JSON fallback:', fallbackReason);
    }
    return fallbackStore;
  }

  function getDb() {
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const createDatabase =
      options.createDatabase ||
      ((databasePath: string) => {
        const Database = require('better-sqlite3');
        return new Database(databasePath);
      });
    db = createDatabase(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(
      `CREATE TABLE IF NOT EXISTS tool_jobs (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      )`
    ).run();
    return db;
  }

  return {
    loadJobs() {
      if (fallbackStore) return fallbackStore.loadJobs();
      try {
        return getDb()
          .prepare('SELECT json FROM tool_jobs ORDER BY updated_at DESC')
          .all()
          .map((row: { json: string }) => JSON.parse(row.json));
      } catch (error) {
        return activateFallback(error).loadJobs();
      }
    },
    saveJob(job: ToolJob) {
      const value = cloneJob(job);
      if (fallbackStore) {
        fallbackStore.saveJob(value);
        return;
      }
      try {
        getDb()
          .prepare(
            `INSERT INTO tool_jobs (id, request_id, status, updated_at, json)
             VALUES (@id, @requestId, @status, @updatedAt, @json)
             ON CONFLICT(id) DO UPDATE SET
               request_id = excluded.request_id,
               status = excluded.status,
               updated_at = excluded.updated_at,
               json = excluded.json`
          )
          .run({
            id: value.id,
            requestId: value.requestId || '',
            status: value.status,
            updatedAt: value.updatedAt || value.finishedAt || value.startedAt || value.createdAt,
            json: JSON.stringify(value),
          });
      } catch (error) {
        activateFallback(error).saveJob(value);
      }
    },
    deleteJob(id: string) {
      if (fallbackStore) {
        fallbackStore.deleteJob(id);
        return;
      }
      try {
        getDb().prepare('DELETE FROM tool_jobs WHERE id = ?').run(id);
      } catch (error) {
        activateFallback(error).deleteJob(id);
      }
    },
  };
}

function isToolJobLike(value: unknown): value is ToolJob {
  return Boolean(value && typeof value === 'object' && typeof (value as ToolJob).id === 'string');
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}
