export type JobStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'orphaned';

export interface ToolJob {
  id: string;
  requestId?: string;
  toolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs?: number;
  cancelGraceMs?: number;
  durationMs?: number;
  outputPreview?: string;
  error?: string;
  stale?: boolean;
  staleResult?: string;
  rollbackError?: string;
  orphaned?: boolean;
}

export interface JobStore {
  loadJobs(): ToolJob[];
  saveJob(job: ToolJob): void;
  deleteJob(id: string): void;
}

export type RunJobOptions = {
  timeoutMs?: number;
  cancelGraceMs?: number;
  rollback?: (job: ToolJob, error: Error) => Promise<void> | void;
  rollbackStatuses?: JobStatus[];
};

type ActiveRun = {
  token: string;
  controller: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  terminalReject: (error: Error) => void;
  rollback?: RunJobOptions['rollback'];
  rollbackStatuses: Set<JobStatus>;
  rollbackStarted: boolean;
};

type JobRuntimeOptions = {
  store?: JobStore | null;
  now?: () => Date;
  maxRetainedTerminalJobs?: number;
  terminalJobTtlMs?: number;
};

const DEFAULT_CANCEL_GRACE_MS = 1000;
const DEFAULT_MCP_TIMEOUT_MS = 60_000;
const DEFAULT_RUN_CODE_TIMEOUT_MS = 7_000;
const DEFAULT_INDEX_WORKSPACE_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_PREVIEW = 1000;

export class ToolJobError extends Error {
  status: JobStatus;
  jobId: string;

  constructor(message: string, job: ToolJob) {
    super(message);
    this.name = 'ToolJobError';
    this.status = job.status;
    this.jobId = job.id;
  }
}

function invokeJobRunner(fn: (signal: AbortSignal) => Promise<string>, signal: AbortSignal): Promise<string> {
  try {
    return Promise.resolve(fn(signal));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function createJobRuntime(options: JobRuntimeOptions = {}) {
  const jobs = new Map<string, ToolJob>();
  const activeRuns = new Map<string, ActiveRun>();
  let store = options.store || null;
  const now = options.now || (() => new Date());
  const maxRetainedTerminalJobs = options.maxRetainedTerminalJobs ?? 100;
  const terminalJobTtlMs = options.terminalJobTtlMs ?? 24 * 60 * 60 * 1000;

  function nowIso() {
    return now().toISOString();
  }

  function persist(job: ToolJob) {
    job.updatedAt = nowIso();
    if (!store) return;
    try {
      store.saveJob(cloneJob(job));
    } catch (error) {
      console.error('[job-runtime] Failed to persist job:', normalizeError(error));
    }
  }

  function removePersistedJob(id: string) {
    if (!store) return;
    try {
      store.deleteJob(id);
    } catch (error) {
      console.error('[job-runtime] Failed to delete job:', normalizeError(error));
    }
  }

  function loadStoredJobs() {
    if (!store) return;
    try {
      for (const loaded of store.loadJobs()) {
        const job = normalizeStoredJob(loaded, nowIso());
        if (isActiveStatus(job.status)) {
          job.status = 'orphaned';
          job.orphaned = true;
          job.error = '应用上次退出时任务仍在运行，已标记为中断。';
          job.finishedAt = job.finishedAt || nowIso();
        }
        jobs.set(job.id, job);
        persist(job);
      }
    } catch (error) {
      console.error('[job-runtime] Failed to load persisted jobs:', normalizeError(error));
    }
  }

  function setStore(nextStore: JobStore | null) {
    store = nextStore;
    jobs.clear();
    activeRuns.clear();
    loadStoredJobs();
  }

  function setJobPatch(id: string, patch: Partial<ToolJob>) {
    const job = jobs.get(id);
    if (!job) return undefined;
    Object.assign(job, patch);
    persist(job);
    return job;
  }

  function cleanupActiveRun(id: string) {
    const active = activeRuns.get(id);
    if (!active) return;
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    if (active.cancelTimer) clearTimeout(active.cancelTimer);
    activeRuns.delete(id);
  }

  function transitionTerminal(id: string, status: JobStatus, patch: Partial<ToolJob> = {}) {
    const job = jobs.get(id);
    if (!job || isTerminalStatus(job.status)) return job;
    cleanupActiveRun(id);
    const started = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
    const finishedAt = nowIso();
    Object.assign(job, {
      ...patch,
      status,
      finishedAt,
      durationMs: Number.isFinite(started) ? Math.max(0, Date.parse(finishedAt) - started) : job.durationMs,
    });
    persist(job);
    pruneTerminalJobs();
    return job;
  }

  function rejectWithTerminal(id: string, status: 'cancelled' | 'timed_out', message: string) {
    const active = activeRuns.get(id);
    const job = transitionTerminal(id, status, { error: message });
    if (!active || !job) return;
    active.controller.abort();
    const error = new ToolJobError(message, job);
    void runRollbackFromActive(active, job, error, status);
    active.terminalReject(error);
  }

  async function runRollbackFromActive(active: ActiveRun, job: ToolJob, error: Error, status: JobStatus) {
    if (!active.rollback || active.rollbackStarted) return;
    if (!active.rollbackStatuses.has(status)) return;
    active.rollbackStarted = true;
    try {
      await active.rollback(cloneJob(job), error);
    } catch (rollbackError) {
      setJobPatch(job.id, { rollbackError: normalizeError(rollbackError) });
    }
  }

  function pruneTerminalJobs() {
    const terminal = [...jobs.values()]
      .filter((job) => isTerminalStatus(job.status))
      .sort((a, b) => jobTimestamp(b) - jobTimestamp(a));
    const cutoff = now().getTime() - terminalJobTtlMs;
    for (let index = 0; index < terminal.length; index++) {
      const job = terminal[index];
      if (index < maxRetainedTerminalJobs && jobTimestamp(job) >= cutoff) continue;
      jobs.delete(job.id);
      removePersistedJob(job.id);
    }
  }

  loadStoredJobs();

  return {
    configureStore(nextStore: JobStore | null): void {
      setStore(nextStore);
    },
    createJob(input: {
      id: string;
      requestId?: string;
      toolCallId?: string;
      toolName: string;
      args: Record<string, unknown>;
      timeoutMs?: number;
      cancelGraceMs?: number;
    }): ToolJob {
      const job: ToolJob = {
        ...input,
        timeoutMs: input.timeoutMs,
        cancelGraceMs: input.cancelGraceMs,
        status: 'queued',
        createdAt: nowIso(),
      };
      jobs.set(job.id, job);
      persist(job);
      pruneTerminalJobs();
      return cloneJob(job);
    },
    getJob(id: string): ToolJob | undefined {
      const job = jobs.get(id);
      return job ? cloneJob(job) : undefined;
    },
    listJobs(): ToolJob[] {
      return [...jobs.values()].map(cloneJob);
    },
    cancelJob(id: string, reason = '任务已取消。'): void {
      const job = jobs.get(id);
      if (!job || isTerminalStatus(job.status)) return;
      const active = activeRuns.get(id);
      if (!active) {
        transitionTerminal(id, 'cancelled', { error: reason });
        return;
      }
      setJobPatch(id, { status: 'cancelling', error: reason });
      active.controller.abort();
      if (active.cancelTimer) clearTimeout(active.cancelTimer);
      const graceMs = clampInt(job.cancelGraceMs, 0, MAX_TIMEOUT_MS, DEFAULT_CANCEL_GRACE_MS);
      active.cancelTimer = setTimeout(() => {
        rejectWithTerminal(id, 'cancelled', reason);
      }, graceMs);
    },
    cancelRequestJobs(requestId: string, reason = '请求已取消，关联工具任务已停止。'): void {
      for (const job of jobs.values()) {
        if (job.requestId === requestId && !isTerminalStatus(job.status)) {
          const active = activeRuns.get(job.id);
          if (!active) {
            transitionTerminal(job.id, 'cancelled', { error: reason });
            continue;
          }
          setJobPatch(job.id, { status: 'cancelling', error: reason });
          active.controller.abort();
          if (active.cancelTimer) clearTimeout(active.cancelTimer);
          const graceMs = clampInt(job.cancelGraceMs, 0, MAX_TIMEOUT_MS, DEFAULT_CANCEL_GRACE_MS);
          active.cancelTimer = setTimeout(() => {
            rejectWithTerminal(job.id, 'cancelled', reason);
          }, graceMs);
        }
      }
    },
    async runJob(
      id: string,
      fn: (signal: AbortSignal) => Promise<string>,
      runOptions: RunJobOptions = {}
    ): Promise<string> {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown job: ${id}`);
      if (isTerminalStatus(job.status)) throw new ToolJobError(`Job ${id} is already ${job.status}.`, job);

      const controller = new AbortController();
      const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timeoutMs = clampInt(
        runOptions.timeoutMs,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
        resolveToolJobTimeout(job.toolName)
      );
      const cancelGraceMs = clampInt(
        runOptions.cancelGraceMs,
        0,
        MAX_TIMEOUT_MS,
        job.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
      );
      const rollbackStatuses = new Set<JobStatus>(runOptions.rollbackStatuses || ['failed', 'cancelled', 'timed_out']);

      let terminalReject: (error: Error) => void = () => {};
      const terminalPromise = new Promise<never>((_resolve, reject) => {
        terminalReject = reject;
      });
      terminalPromise.catch(() => {
        // Promise.race observes this promise; the catch only prevents early unhandled rejection noise in tests/runtimes.
      });
      const active: ActiveRun = {
        token,
        controller,
        timeoutTimer: null,
        cancelTimer: null,
        terminalReject,
        rollback: runOptions.rollback,
        rollbackStatuses,
        rollbackStarted: false,
      };
      activeRuns.set(id, active);
      setJobPatch(id, {
        status: 'running',
        startedAt: nowIso(),
        timeoutMs,
        cancelGraceMs,
        error: undefined,
        stale: false,
        staleResult: undefined,
      });

      active.timeoutTimer = setTimeout(() => {
        rejectWithTerminal(
          id,
          'timed_out',
          `工具 ${job.toolName} 执行超过 ${Math.round(timeoutMs / 1000)} 秒，已超时停止。`
        );
      }, timeoutMs);

      const runPromise = invokeJobRunner(fn, controller.signal);
      runPromise.then(
        (output) => recordStaleCompletion(id, token, output),
        (error) => recordStaleCompletion(id, token, undefined, error)
      );

      try {
        const output = await Promise.race([runPromise, terminalPromise]);
        const current = jobs.get(id);
        if (!current) return output;
        if (current.status === 'cancelling') {
          const message = current.error || '任务已取消。';
          const activeBeforeTerminal = activeRuns.get(id);
          transitionTerminal(id, 'cancelled', { error: message });
          const error = new ToolJobError(message, jobs.get(id) || current);
          if (activeBeforeTerminal)
            await runRollbackFromActive(activeBeforeTerminal, jobs.get(id) || current, error, 'cancelled');
          throw error;
        }
        if (isTerminalStatus(current.status))
          throw new ToolJobError(current.error || `Job ${id} is ${current.status}.`, current);
        transitionTerminal(id, 'completed', { outputPreview: String(output || '').slice(0, MAX_OUTPUT_PREVIEW) });
        return output;
      } catch (error) {
        const current = jobs.get(id);
        if (!current) throw error;
        if (current.status === 'cancelling') {
          const message = current.error || normalizeError(error) || '任务已取消。';
          const activeBeforeTerminal = activeRuns.get(id);
          transitionTerminal(id, 'cancelled', { error: message });
          const jobError = new ToolJobError(message, jobs.get(id) || current);
          if (activeBeforeTerminal) {
            await runRollbackFromActive(activeBeforeTerminal, jobs.get(id) || current, jobError, 'cancelled');
          }
          throw jobError;
        }
        if (current.status === 'cancelled' || current.status === 'timed_out') throw error;
        if (!isTerminalStatus(current.status)) {
          const activeBeforeTerminal = activeRuns.get(id);
          transitionTerminal(id, 'failed', { error: normalizeError(error) });
          if (activeBeforeTerminal) {
            await runRollbackFromActive(
              activeBeforeTerminal,
              jobs.get(id) || current,
              error instanceof Error ? error : new Error(normalizeError(error)),
              'failed'
            );
          }
        }
        throw error;
      } finally {
        const activeNow = activeRuns.get(id);
        if (activeNow?.token === token && isTerminalStatus(jobs.get(id)?.status || 'failed')) cleanupActiveRun(id);
      }
    },
  };

  function recordStaleCompletion(id: string, token: string, output?: string, error?: unknown) {
    const active = activeRuns.get(id);
    const job = jobs.get(id);
    if (active?.token === token || !job || !isTerminalStatus(job.status)) return;
    setJobPatch(id, {
      stale: true,
      staleResult: error ? normalizeError(error) : String(output || '').slice(0, MAX_OUTPUT_PREVIEW),
    });
  }
}

export const defaultJobRuntime = createJobRuntime();

export function configureDefaultJobRuntime(store: JobStore | null) {
  defaultJobRuntime.configureStore(store);
}

export function shouldTrackToolJob(toolName: string): boolean {
  return toolName === 'index_workspace' || toolName === 'run_code' || toolName.startsWith('mcp__');
}

export function resolveToolJobTimeout(toolName: string, explicitTimeoutMs?: unknown): number {
  if (explicitTimeoutMs !== undefined && explicitTimeoutMs !== null) {
    return clampInt(explicitTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_MCP_TIMEOUT_MS);
  }
  if (toolName === 'run_code') return DEFAULT_RUN_CODE_TIMEOUT_MS;
  if (toolName === 'index_workspace') return DEFAULT_INDEX_WORKSPACE_TIMEOUT_MS;
  if (toolName.startsWith('mcp__')) return DEFAULT_MCP_TIMEOUT_MS;
  return DEFAULT_MCP_TIMEOUT_MS;
}

export function createMemoryJobStore(initialJobs: ToolJob[] = []): JobStore {
  const values = new Map<string, ToolJob>(initialJobs.map((job) => [job.id, cloneJob(job)]));
  return {
    loadJobs() {
      return [...values.values()].map(cloneJob);
    },
    saveJob(job: ToolJob) {
      values.set(job.id, cloneJob(job));
    },
    deleteJob(id: string) {
      values.delete(id);
    },
  };
}

export function cloneJob(job: ToolJob): ToolJob {
  return JSON.parse(JSON.stringify(job)) as ToolJob;
}

export function isTerminalStatus(status: JobStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'timed_out', 'orphaned'].includes(status);
}

function isActiveStatus(status: JobStatus): boolean {
  return ['queued', 'running', 'cancelling'].includes(status);
}

function normalizeStoredJob(input: ToolJob, fallbackDate: string): ToolJob {
  return {
    id: String(input.id || ''),
    requestId: input.requestId ? String(input.requestId) : undefined,
    toolCallId: input.toolCallId ? String(input.toolCallId) : undefined,
    toolName: String(input.toolName || 'unknown_tool'),
    args: input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {},
    status: normalizeStatus(input.status),
    createdAt: String(input.createdAt || fallbackDate),
    updatedAt: input.updatedAt ? String(input.updatedAt) : undefined,
    startedAt: input.startedAt ? String(input.startedAt) : undefined,
    finishedAt: input.finishedAt ? String(input.finishedAt) : undefined,
    timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
    cancelGraceMs: typeof input.cancelGraceMs === 'number' ? input.cancelGraceMs : undefined,
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : undefined,
    outputPreview: input.outputPreview ? String(input.outputPreview) : undefined,
    error: input.error ? String(input.error) : undefined,
    stale: Boolean(input.stale),
    staleResult: input.staleResult ? String(input.staleResult) : undefined,
    rollbackError: input.rollbackError ? String(input.rollbackError) : undefined,
    orphaned: Boolean(input.orphaned),
  };
}

function normalizeStatus(value: unknown): JobStatus {
  const status = String(value || 'queued') as JobStatus;
  return ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'timed_out', 'orphaned'].includes(
    status
  )
    ? status
    : 'queued';
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function jobTimestamp(job: ToolJob): number {
  return Date.parse(job.finishedAt || job.updatedAt || job.startedAt || job.createdAt) || 0;
}
