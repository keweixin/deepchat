export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ToolJob {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  outputPreview?: string;
  error?: string;
}

export function createJobRuntime() {
  const jobs = new Map<string, ToolJob>();
  const controllers = new Map<string, AbortController>();

  return {
    createJob(input: { id: string; toolName: string; args: Record<string, unknown> }): ToolJob {
      const job: ToolJob = { ...input, status: 'queued', createdAt: new Date().toISOString() };
      jobs.set(job.id, job);
      return job;
    },
    getJob(id: string): ToolJob | undefined {
      return jobs.get(id);
    },
    cancelJob(id: string): void {
      controllers.get(id)?.abort();
      const job = jobs.get(id);
      if (job) {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
      }
    },
    async runJob(id: string, fn: (signal: AbortSignal) => Promise<string>): Promise<string> {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown job: ${id}`);
      const controller = new AbortController();
      controllers.set(id, controller);
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      try {
        const output = await fn(controller.signal);
        if ((job.status as JobStatus) !== 'cancelled') {
          job.status = 'completed';
          job.outputPreview = String(output || '').slice(0, 1000);
          job.finishedAt = new Date().toISOString();
        }
        return output;
      } catch (error) {
        if ((job.status as JobStatus) !== 'cancelled') job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        job.finishedAt = new Date().toISOString();
        throw error;
      } finally {
        controllers.delete(id);
      }
    },
  };
}

export const defaultJobRuntime = createJobRuntime();

export function shouldTrackToolJob(toolName: string): boolean {
  return toolName === 'index_workspace' || toolName === 'run_code' || toolName.startsWith('mcp__');
}
