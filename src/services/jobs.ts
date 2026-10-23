/**
 * Jobs for operations longer than ordinary calls, such as months of history
 * or hundreds of previews. Tools may wait briefly for completion,
 * then return `job_id` for separate progress calls.
 *
 * Each job has independent state persisted in the database and returns
 * to the queue after a restart, at most twice before failing.
 */
import { randomBytes } from 'node:crypto';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import type { JobRecord, Storage } from '../storage/port.js';

export interface JobContext {
  job: JobRecord;
  /** Persists progress visible to the agent. */
  progress(update: Record<string, unknown>): void;
  /** True during shutdown; executors must stop and resume after startup. */
  stopping(): boolean;
}

export type JobRunner = (context: JobContext) => Promise<Record<string, unknown>>;

export interface JobManagerOptions {
  storage: Storage;
  /** Maximum concurrent jobs. */
  concurrency?: number;
  log?: Logger;
}

/** Maximum job resumptions after restarts. */
const MAX_RESUMES = 2;

export class JobManager {
  private readonly storage: Storage;
  private readonly concurrency: number;
  private readonly log: Logger;
  private readonly runners = new Map<string, JobRunner>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private active = 0;
  private stopped = false;

  constructor(options: JobManagerOptions) {
    this.storage = options.storage;
    this.concurrency = options.concurrency ?? 2;
    this.log = options.log ?? createLogger('jobs');
  }

  /** Registers a job executor; persisted parameters allow restart resumption. */
  register(kind: string, runner: JobRunner): void {
    this.runners.set(kind, runner);
  }

  start(input: { userId: string; accountId?: string | null; kind: string; params: Record<string, unknown> }): JobRecord {
    if (!this.runners.has(input.kind)) {
      throw new GatewayError('INVALID_ARGUMENT', `Unknown job kind "${input.kind}".`);
    }
    const job = this.storage.jobs.create({ id: `job_${randomBytes(6).toString('hex')}`, ...input });
    this.pump();
    return job;
  }

  /** Looks up a user job; another user's job is indistinguishable from a missing one. */
  get(id: string, userId: string): JobRecord {
    const job = this.storage.jobs.get(id);
    if (!job || job.userId !== userId) {
      throw new GatewayError('NOT_FOUND', `Job "${id}" not found.`);
    }
    return job;
  }

  /** Waits at most `ms` for completion and returns current state. */
  async waitFor(id: string, userId: string, ms: number): Promise<JobRecord> {
    const done = (j: JobRecord): boolean => j.state === 'done' || j.state === 'failed';
    const current = this.get(id, userId);
    if (done(current) || ms <= 0) return current;
    await new Promise<void>(resolve => {
      const list = this.waiters.get(id) ?? [];
      const finish = (): void => {
        clearTimeout(timer);
        // Remove timed-out waiters too, preventing accumulation during long-job polling.
        const rest = (this.waiters.get(id) ?? []).filter(w => w !== finish);
        if (rest.length > 0) this.waiters.set(id, rest);
        else this.waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      list.push(finish);
      this.waiters.set(id, list);
    });
    return this.get(id, userId);
  }

  /** Requeues interrupted jobs after restart and resumes execution. */
  resume(): number {
    // A job repeatedly left running after crashes is likely causing them:
    // a hanging call kills the process. Close this job instead of restarting it.
    for (const job of this.storage.jobs.list({ state: 'running', limit: 500 })) {
      const resumes = Number(job.progress._resumes ?? 0) + 1;
      if (resumes > MAX_RESUMES) {
        this.storage.jobs.update(job.id, { state: 'failed', error: `interrupted by ${resumes} gateway restarts in a row, not resumed again` });
      } else {
        this.storage.jobs.update(job.id, { progress: { ...job.progress, _resumes: resumes } });
      }
    }
    const requeued = this.storage.jobs.requeueRunning();
    this.pump();
    return requeued;
  }

  stop(): void {
    this.stopped = true;
    for (const id of this.waiters.keys()) this.notify(id);
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.active < this.concurrency) {
      // Always run the oldest job first, regardless of queue size.
      const next = this.storage.jobs.list({ state: 'queued', limit: 50, oldestFirst: true }).find(j => this.runners.has(j.kind));
      if (!next) return;
      this.active++;
      this.storage.jobs.update(next.id, { state: 'running' });
      void this.run(next.id).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const job = this.storage.jobs.get(id);
    if (!job) return;
    const runner = this.runners.get(job.kind)!;
    let progress = { ...job.progress };
    try {
      const result = await runner({
        job,
        progress: update => {
          progress = { ...progress, ...update };
          this.storage.jobs.update(id, { progress });
        },
        stopping: () => this.stopped,
      });
      if (this.stopped) {
        // On shutdown, leave the job running in storage so startup requeues it.
        return;
      }
      this.storage.jobs.update(id, { state: 'done', result });
    } catch (err) {
      if (this.stopped) return;
      const message = isGatewayError(err) ? `${err.code}: ${err.message}` : (err as Error).message;
      this.log.warn('job failed', { job: id, kind: job.kind, error: message });
      this.storage.jobs.update(id, { state: 'failed', error: message });
    } finally {
      this.notify(id);
    }
  }

  private notify(id: string): void {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    for (const wake of list) wake();
  }
}
