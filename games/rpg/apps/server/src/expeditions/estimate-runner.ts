/**
 * Estimate runners: where the Monte Carlo CPU work happens. The default is a small `node:worker_threads` pool so a
 * cold estimate (hundreds of milliseconds to ~2 s of simulation) never blocks the API event loop; the chunks of one job
 * run in parallel on the pool. The inline runner computes on the calling thread (tests, tools).
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import type { LoadedContent } from '@engine/server-kit';
import { createRpgActivityRegistry } from '@rpg/rpg-sim';

import { ESTIMATE_CHUNKS, sampleChunk } from './estimate-samples.ts';
import type { EstimateJob, RunSample } from './estimate-samples.ts';

export interface EstimateRunner {
  /** All samples of `job`, chunks merged in chunk order (deterministic for the job). */
  run(job: EstimateJob): Promise<RunSample[]>;
  /** Optional: prepare ahead of the first job (e.g. start threads and load modules). Never rejects. */
  warmUp?(): Promise<void>;
  close(): Promise<void>;
}

export function createInlineEstimateRunner(content: LoadedContent): EstimateRunner {
  const registry = createRpgActivityRegistry(content);
  return {
    async run(job) {
      const samples: RunSample[] = [];
      for (let chunk = 0; chunk < ESTIMATE_CHUNKS; chunk++) samples.push(...sampleChunk(registry, job, chunk));
      return samples;
    },
    async close() {},
  };
}

/** Default pool size: one thread per spare core, at least 1 and at most the chunk count. */
export function defaultEstimateWorkers(): number {
  return Math.max(1, Math.min(ESTIMATE_CHUNKS, availableParallelism() - 1));
}

interface Task {
  readonly id: number;
  readonly job: EstimateJob;
  readonly chunk: number;
  readonly resolve: (samples: RunSample[]) => void;
  readonly reject: (error: Error) => void;
}
interface Slot { worker: Worker | null; task: Task | null; ready: Promise<void> }

/**
 * Fixed-size worker pool, spawned lazily on the first job. Each worker receives the content bundle once
 * (`workerData`). A crashed worker fails its current chunk (the estimate request gets an error) and is replaced on
 * the next task. Workers are `unref`ed and terminated by `close()`.
 */
export function createWorkerEstimateRunner(content: LoadedContent, options: { workers?: number } = {}): EstimateRunner {
  const size = options.workers ?? defaultEstimateWorkers();
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('workers must be a positive integer');
  const slots: Slot[] = Array.from({ length: size }, () => ({ worker: null, task: null, ready: Promise.resolve() }));
  const queue: Task[] = [];
  let nextId = 1;
  let closed = false;

  function spawn(slot: Slot): Worker {
    const worker = new Worker(new URL('./estimate-worker.ts', import.meta.url), { workerData: { content } });
    worker.unref();
    slot.ready = new Promise<void>(resolve => {
      const done = () => resolve();
      worker.once('message', done);
      worker.once('exit', done);
    });
    worker.on('message', (message: { id?: number; ready?: boolean; samples?: RunSample[]; error?: string }) => {
      if (message.ready) return;
      const task = slot.task;
      if (!task || task.id !== message.id) return;
      slot.task = null;
      if (message.error !== undefined || !message.samples) task.reject(new Error(`estimate worker failed: ${message.error ?? 'no samples'}`));
      else task.resolve(message.samples);
      pump();
    });
    const fail = (error: Error) => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      const task = slot.task;
      slot.task = null;
      task?.reject(error);
      pump();
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`estimate worker exited (${code})`)));
    return worker;
  }

  function pump(): void {
    if (closed) return;
    for (const slot of slots) {
      if (slot.task || queue.length === 0) continue;
      const task = queue.shift() as Task;
      slot.worker ??= spawn(slot);
      slot.task = task;
      slot.worker.postMessage({ id: task.id, job: task.job, chunk: task.chunk });
    }
  }

  return {
    async run(job) {
      if (closed) throw new Error('estimate runner closed');
      const chunks = Array.from({ length: ESTIMATE_CHUNKS }, (_, chunk) => new Promise<RunSample[]>((resolve, reject) => {
        queue.push({ id: nextId++, job, chunk, resolve, reject });
      }));
      pump();
      return (await Promise.all(chunks)).flat();
    },
    async warmUp() {
      if (closed) return;
      for (const slot of slots) slot.worker ??= spawn(slot);
      await Promise.all(slots.map(slot => slot.ready));
    },
    async close() {
      closed = true;
      for (const task of queue.splice(0)) task.reject(new Error('estimate runner closed'));
      await Promise.all(slots.map(async slot => {
        const worker = slot.worker;
        slot.worker = null;
        slot.task?.reject(new Error('estimate runner closed'));
        slot.task = null;
        if (worker) await worker.terminate();
      }));
    },
  };
}
