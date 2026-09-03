import fs from 'node:fs';

for (const file of [
  'data/test-smoke.db',
  'data/test-smoke.db-shm',
  'data/test-smoke.db-wal',
]) {
  fs.rmSync(file, { force: true });
}
