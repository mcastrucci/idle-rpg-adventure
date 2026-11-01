#!/usr/bin/env node
// Entry point of `content-cli`. Node >= 22.18 runs TypeScript files directly (type stripping, enabled by default).
import process from 'node:process';

import { runCli } from './cli.ts';

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = code;
