import { createDatabase, parseServerConfig } from '@engine/server-kit';

try {
  const database = createDatabase(parseServerConfig(process.env));
  try { await database.migrate(); }
  finally { await database.close(); }
  process.stdout.write('Database migrations applied.\n');
} catch {
  process.stderr.write('Database migration failed; check database configuration.\n');
  process.exitCode = 1;
}
