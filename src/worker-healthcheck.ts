/**
 * Healthcheck del contenedor `worker`: sale con 0 si el latido
 * (`WORKER_HEARTBEAT_FILE`) se escribió hace menos de
 * `WORKER_HEARTBEAT_MAX_AGE_MS`. El worker solo lo escribe cuando Postgres,
 * Redis, el relay y los workers de las colas están bien.
 *
 *   node dist/worker-healthcheck.js
 *
 * Sin dependencias ni Nest: se ejecuta cada pocos segundos.
 */
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export function heartbeatAgeMs(file: string, now = Date.now()): number | null {
  try {
    const content = JSON.parse(readFileSync(file, 'utf8')) as { at?: string };
    const at = content.at ? Date.parse(content.at) : NaN;
    return Number.isNaN(at) ? null : now - at;
  } catch {
    return null;
  }
}

if (require.main === module) {
  const file =
    process.env.WORKER_HEARTBEAT_FILE ?? join(tmpdir(), 'doc-worker.heartbeat');
  const maxAge = Number(process.env.WORKER_HEARTBEAT_MAX_AGE_MS ?? 60000);
  const age = heartbeatAgeMs(file);
  process.exit(age !== null && age >= 0 && age < maxAge ? 0 : 1);
}
