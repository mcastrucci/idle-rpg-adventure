#!/usr/bin/env node
// Entry point of `balance-sim`. Node >= 22.18 runs TypeScript files directly (type stripping, enabled by default).
// Wall-clock runtime goes to stderr only, so the report itself stays deterministic.
import process from 'node:process';

import { runCli } from './cli.ts';

const started = performance.now();
const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
if (code === 0) process.stderr.write(`balance-sim finished in ${Math.round(performance.now() - started)} ms\n`);
process.exitCode = code;
