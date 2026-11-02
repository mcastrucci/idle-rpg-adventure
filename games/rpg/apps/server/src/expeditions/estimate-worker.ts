/**
 * Worker-thread entry of the estimate pool (`estimate-runner.ts`). Builds the RPG activity registry once from the
 * content bundle passed in `workerData`, then answers `{ id, job, chunk }` messages with that chunk's raw samples.
 * Pure CPU work: no database, clock or network access.
 */
import { parentPort, workerData } from 'node:worker_threads';

import type { LoadedContent } from '@engine/server-kit';
import { createRpgActivityRegistry } from '@rpg/rpg-sim';

import { sampleChunk } from './estimate-samples.ts';
import type { EstimateJob } from './estimate-samples.ts';

const port = parentPort;
if (!port) throw new Error('estimate-worker must run as a worker thread');
const registry = createRpgActivityRegistry((workerData as { content: LoadedContent }).content);
port.postMessage({ ready: true });

port.on('message', (message: { id: number; job: EstimateJob; chunk: number }) => {
  try {
    port.postMessage({ id: message.id, samples: sampleChunk(registry, message.job, message.chunk) });
  } catch (error) {
    port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
