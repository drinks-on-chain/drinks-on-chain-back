/**
 * Copia los fixtures de `@drinks-on-chain/mocks` que usa la semilla de
 * demostración (0.10, OPS-09) a `src/seed/fixtures/`.
 *
 *   pnpm seed:sync                                # ../drinks-on-chain-mocks
 *   pnpm seed:sync -- /ruta/a/drinks-on-chain-mocks
 *
 * Los fixtures se versionan en este repo (la imagen no depende del de mocks).
 * Se quita la contraseña de demo de los mocks (`_mock.password`): la semilla
 * usa la de `SEED_DEMO_PASSWORD`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ERP_FILES = [
  'wineries.json',
  'users.json',
  'wallets.json',
  'terroirs.json',
  'harvest-batches.json',
  'fermentation-tanks.json',
  'fermentation-logs.json',
  'enological-treatments.json',
  'wine-aging.json',
  'production-batches.json',
  'bottling.json',
  'lab-analyses.json',
  // Ola 2 (mocks 0.5.x): el lote del servidor y sus registros
  'lots.json',
  'maturity-analyses.json',
  'phyto-decisions.json',
  'lot-events.json',
  'corrections.json',
] as const;
const BACKOFFICE_FILES = [
  'member-blocks.json',
  'invitations.json',
  'staff-mfa.json',
  'applications.json',
  'winery-profiles.json',
] as const;

const mocksDir = resolve(
  process.argv[2] ?? join('..', 'drinks-on-chain-mocks'),
);
const outDir = resolve('src', 'seed', 'fixtures');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function withoutPasswords(users: unknown): unknown {
  if (!Array.isArray(users)) {
    throw new Error('users.json debe ser una lista');
  }
  return users.map((user: Record<string, unknown>) => {
    const mock = { ...(user._mock as Record<string, unknown>) };
    delete mock.password;
    return { ...user, _mock: mock };
  });
}

/**
 * Del segundo factor de los mocks solo se copia quién está inscrito: el
 * secreto y los códigos de recuperación no se versionan aquí (el secreto de
 * la semilla sale de `SEED_DEMO_TOTP_SECRET`).
 */
function withoutMfaSecrets(entries: unknown): unknown {
  if (!Array.isArray(entries)) {
    throw new Error('staff-mfa.json debe ser una lista');
  }
  return entries.map((entry: Record<string, unknown>) => ({
    userId: entry.userId,
    enrolled: entry.enrolled,
    enrolledAt: entry.enrolledAt,
  }));
}

function gitDescribe(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'describe', '--tags', '--always'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

mkdirSync(outDir, { recursive: true });
for (const file of ERP_FILES) {
  const data = readJson(join(mocksDir, 'fixtures', 'erp', file));
  writeJson(
    join(outDir, file),
    file === 'users.json' ? withoutPasswords(data) : data,
  );
}
for (const file of BACKOFFICE_FILES) {
  const data = readJson(join(mocksDir, 'fixtures', 'backoffice', file));
  writeJson(
    join(outDir, file),
    file === 'staff-mfa.json' ? withoutMfaSecrets(data) : data,
  );
}
const pkg = readJson(join(mocksDir, 'package.json')) as { version: string };
writeJson(join(outDir, 'source.json'), {
  package: '@drinks-on-chain/mocks',
  version: pkg.version,
  git: gitDescribe(mocksDir),
  referenceDay: '2026-09-25',
  files: [
    ...ERP_FILES.map((f) => `fixtures/erp/${f}`),
    ...BACKOFFICE_FILES.map((f) => `fixtures/backoffice/${f}`),
  ],
});
console.log(`Fixtures de ${mocksDir} (v${pkg.version}) copiados a ${outDir}`);
