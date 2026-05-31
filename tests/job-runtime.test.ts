import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createJobRuntime, createMemoryJobStore, shouldTrackToolJob, type ToolJob } from '../electron/job-runtime.js';
import { createJsonJobStore, createSqliteJobStore } from '../electron/job-stores.js';

describe('job runtime', () => {
  it('tracks queued, running, completed states', async () => {
    const runtime = createJobRuntime();
    const job = runtime.createJob({ id: 'job-1', toolName: 'index_workspace', args: { root: 'E:/repo' } });
    expect(job.status).toBe('queued');

    await runtime.runJob(job.id, async () => 'indexed');
    expect(runtime.getJob(job.id)?.status).toBe('completed');
    expect(runtime.getJob(job.id)?.outputPreview).toBe('indexed');
  });

  it('cancels a running job through AbortSignal and cleans controller state', async () => {
    vi.useFakeTimers();
    const runtime = createJobRuntime();
    const job = runtime.createJob({ id: 'job-2', toolName: 'run_code', args: {} });
    const run = runtime.runJob(job.id, async (signal) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return 'never';
    });

    runtime.cancelJob(job.id);
    await expect(run).rejects.toThrow(/任务已取消|aborted/);
    expect(runtime.getJob(job.id)?.status).toBe('cancelled');
    vi.useRealTimers();
  });

  it('hard-times out an unresponsive job and ignores stale completion', async () => {
    vi.useFakeTimers();
    const runtime = createJobRuntime();
    const job = runtime.createJob({ id: 'job-3', toolName: 'mcp__server__tool', args: {} });
    let resolveLate!: (value: string) => void;
    const run = runtime.runJob(
      job.id,
      async () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
      { timeoutMs: 5000 }
    );

    const assertion = expect(run).rejects.toThrow(/超时|timed/i);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(runtime.getJob(job.id)?.status).toBe('timed_out');

    resolveLate('late success');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    const finished = runtime.getJob(job.id);
    expect(finished?.status).toBe('timed_out');
    expect(finished?.stale).toBe(true);
    expect(finished?.staleResult).toContain('late success');
    vi.useRealTimers();
  });

  it('cancels all non-terminal jobs for a request', async () => {
    vi.useFakeTimers();
    const runtime = createJobRuntime();
    const a = runtime.createJob({ id: 'job-a', requestId: 'req-1', toolName: 'run_code', args: {} });
    const b = runtime.createJob({ id: 'job-b', requestId: 'req-1', toolName: 'mcp__x__y', args: {} });
    const runA = runtime.runJob(a.id, async () => new Promise<string>(() => {}), { timeoutMs: 5000 });
    const runB = runtime.runJob(b.id, async () => new Promise<string>(() => {}), { timeoutMs: 5000 });

    runtime.cancelRequestJobs('req-1');
    expect(runtime.getJob(a.id)?.status).toBe('cancelling');
    const assertionA = expect(runA).rejects.toThrow(/取消|cancel/i);
    const assertionB = expect(runB).rejects.toThrow(/取消|cancel/i);
    await vi.advanceTimersByTimeAsync(1000);
    await assertionA;
    await assertionB;
    expect(runtime.getJob(a.id)?.status).toBe('cancelled');
    expect(runtime.getJob(b.id)?.status).toBe('cancelled');
    vi.useRealTimers();
  });

  it('marks persisted active jobs as orphaned on runtime startup', () => {
    const stored: ToolJob = {
      id: 'job-old',
      requestId: 'req-old',
      toolName: 'index_workspace',
      args: {},
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    const runtime = createJobRuntime({ store: createMemoryJobStore([stored]) });
    const job = runtime.getJob('job-old');
    expect(job?.status).toBe('orphaned');
    expect(job?.orphaned).toBe(true);
  });

  it('falls back to a JSON job store when sqlite is unavailable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepchat-job-store-'));
    const fallbackPath = path.join(tmpDir, 'jobs.json');
    const fallbackReasons: string[] = [];

    try {
      const runtime = createJobRuntime({
        store: createSqliteJobStore(path.join(tmpDir, 'jobs.sqlite'), {
          fallbackPath,
          createDatabase: () => {
            throw new Error('native sqlite unavailable');
          },
          onFallback: (reason) => fallbackReasons.push(reason),
        }),
      });
      const job = runtime.createJob({ id: 'job-fallback', requestId: 'req-fallback', toolName: 'run_code', args: {} });

      await runtime.runJob(job.id, async () => 'ok');

      expect(fallbackReasons).toEqual(['native sqlite unavailable']);
      expect(fs.existsSync(fallbackPath)).toBe(true);

      const restored = createJobRuntime({ store: createJsonJobStore(fallbackPath) });
      expect(restored.getJob(job.id)?.status).toBe('completed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs rollback once when a job fails', async () => {
    const runtime = createJobRuntime();
    const job = runtime.createJob({ id: 'job-rollback', toolName: 'run_code', args: {} });
    const rollback = vi.fn();

    await expect(
      runtime.runJob(
        job.id,
        async () => {
          throw new Error('boom');
        },
        { rollback }
      )
    ).rejects.toThrow('boom');
    expect(runtime.getJob(job.id)?.status).toBe('failed');
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('marks a job failed when the tool throws before returning a promise', async () => {
    const runtime = createJobRuntime();
    const job = runtime.createJob({ id: 'job-sync-throw', toolName: 'run_code', args: {} });
    const rollback = vi.fn();

    await expect(
      runtime.runJob(
        job.id,
        () => {
          throw new Error('sync boom');
        },
        { rollback }
      )
    ).rejects.toThrow('sync boom');

    expect(runtime.getJob(job.id)?.status).toBe('failed');
    expect(runtime.getJob(job.id)?.error).toBe('sync boom');
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('tracks only long-running or external tool categories', () => {
    expect(shouldTrackToolJob('index_workspace')).toBe(true);
    expect(shouldTrackToolJob('run_code')).toBe(true);
    expect(shouldTrackToolJob('mcp__server__tool')).toBe(true);
    expect(shouldTrackToolJob('read_file')).toBe(false);
  });
});
