import { describe, expect, it, vi } from 'vitest';
import { createJobRuntime, shouldTrackToolJob } from '../electron/job-runtime.js';

describe('job runtime', () => {
  it('tracks queued, running, completed states', async () => {
    const runtime = createJobRuntime();
    const job = runtime.createJob({ id: 'job-1', toolName: 'index_workspace', args: { root: 'E:/repo' } });
    expect(job.status).toBe('queued');

    await runtime.runJob(job.id, async () => 'indexed');
    expect(runtime.getJob(job.id)?.status).toBe('completed');
    expect(runtime.getJob(job.id)?.outputPreview).toBe('indexed');
  });

  it('cancels a running job through AbortSignal', async () => {
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
    await expect(run).rejects.toThrow('aborted');
    expect(runtime.getJob(job.id)?.status).toBe('cancelled');
    vi.useRealTimers();
  });

  it('tracks only long-running or external tool categories', () => {
    expect(shouldTrackToolJob('index_workspace')).toBe(true);
    expect(shouldTrackToolJob('run_code')).toBe(true);
    expect(shouldTrackToolJob('mcp__server__tool')).toBe(true);
    expect(shouldTrackToolJob('read_file')).toBe(false);
  });
});
