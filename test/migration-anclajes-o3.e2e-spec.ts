import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Ola 3 · migración `o3_emision_anclaje` sobre **filas reales** (contrato O3
 * §12.2): los anclajes simulados de los embotellados de antes del paso 3.5 se
 * mueven a `legacy_simulated_anchor_tx_hash` y quedan como «sin anclar»; un
 * anclaje confirmado en la red no se toca; nada se borra.
 *
 * La base se migra primero hasta justo antes de esa migración, se siembran
 * embotellados como los que deja la semilla de `v0.2.0` y entonces se aplica.
 */
const MIGRATION = '20261009120000_o3_emision_anclaje';
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `anclajes_e2e_${run}`;

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}
const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);
const prismaCli = require.resolve('prisma/build/index.js');

function migrate(args: string[]): { status: number; output: string } {
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', ...args], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
    },
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

interface BottlingRow {
  id: string;
  blockchain_anchor_tx_hash: string | null;
  is_anchored_on_chain: boolean;
  anchored_at: Date | null;
  legacy_simulated_anchor_tx_hash: string | null;
  blockchain_data_hash: string | null;
  total_bottles_packaged: number;
}

describe('Ola 3 · migración de los anclajes simulados sobre filas reales (e2e)', () => {
  const before = mkdtempSync(join(tmpdir(), 'doc-anclajes-'));
  let prisma: PrismaClient;
  const WINERY = randomUUID();
  const ANCHORED_AT = new Date('2026-09-20T15:00:00.000Z');
  const DATA_HASH = 'd'.repeat(64);
  /** Embotellados de antes del paso 3.5, uno por caso. */
  const BATCH = {
    /** Semilla de demostración: marcado como anclado, con hash de relleno. */
    simulated: randomUUID(),
    /** Gancho simulado a medias: solo el hash, sin la marca. */
    hashOnly: randomUUID(),
    /** Solo la marca y la fecha, sin hash. */
    flagOnly: randomUUID(),
    /** Nunca se "ancló": no hay nada que mover. */
    clean: randomUUID(),
    /** Anclado de verdad (su expediente tiene un anclaje `ANCHORED`). */
    real: randomUUID(),
  };
  const SIMULATED_HASH = `0x_simulated_anchor_${run}`;
  const HASH_ONLY = `SIMULATED_ANCHOR_${run}`;
  const REAL_TX = 'a'.repeat(64);

  const sql = (query: string, ...values: unknown[]) =>
    prisma.$executeRawUnsafe(query, ...values);
  const rows = <T>(query: string, ...values: unknown[]) =>
    prisma.$queryRawUnsafe<T[]>(query, ...values);
  const batch = async (id: string) =>
    (
      await rows<BottlingRow>(
        `SELECT id, blockchain_anchor_tx_hash, is_anchored_on_chain, anchored_at,
                legacy_simulated_anchor_tx_hash, blockchain_data_hash, total_bottles_packaged
         FROM bottling_batches WHERE id = $1::uuid`,
        id,
      )
    )[0];
  const count = async (table: string) =>
    Number(
      (await rows<{ n: bigint }>(`SELECT count(*) AS n FROM "${table}"`))[0].n,
    );

  beforeAll(async () => {
    // 1. La base, justo antes de la migración (ni ella ni las posteriores)
    const laterOrSame = readdirSync('prisma/migrations').filter(
      (name) => /^\d{14}_/.test(name) && name >= MIGRATION,
    );
    expect(laterOrSame).toContain(MIGRATION);
    cpSync('prisma/schema.prisma', join(before, 'schema.prisma'));
    cpSync('prisma/migrations', join(before, 'migrations'), {
      recursive: true,
      filter: (source) => !laterOrSame.some((name) => source.includes(name)),
    });
    expect(
      migrate(['deploy', '--schema', join(before, 'schema.prisma')]),
    ).toMatchObject({ status: 0 });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const columns = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'bottling_batches'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain(
      'legacy_simulated_anchor_tx_hash',
    );

    // 2. Filas como las de desarrollo (SQL directo: el cliente generado ya
    // conoce la columna nueva)
    await sql(
      `INSERT INTO wineries (id, legal_name, commercial_name, beverage_category, tax_id_nit, geographic_region, contact_email)
       VALUES ($1::uuid, 'Bodega de los Anclajes S.R.L.', 'Bodega de los Anclajes', 'WINERY', $2, 'Tarija', 'anclajes@e2e.test')`,
      WINERY,
      `NIT-A-${run.slice(-10)}`,
    );
    const lots: Record<keyof typeof BATCH, string> = {
      simulated: randomUUID(),
      hashOnly: randomUUID(),
      flagOnly: randomUUID(),
      clean: randomUUID(),
      real: randomUUID(),
    };
    let n = 0;
    for (const key of Object.keys(BATCH) as (keyof typeof BATCH)[]) {
      n += 1;
      await sql(
        `INSERT INTO lots (id, winery_id, reference, name, harvest_year, rules, rules_origin, stage)
         VALUES ($1::uuid, $2::uuid, $3, $4, 2026, '{}'::jsonb, 'MIGRATION', 'CERTIFIED')`,
        lots[key],
        WINERY,
        `ANC-L2026-${String(n).padStart(3, '0')}-${run.slice(-6)}`,
        `Lote ${key}`,
      );
    }
    const insertBatch = (
      key: keyof typeof BATCH,
      anchor: { hash: string | null; flag: boolean; at: Date | null },
    ) =>
      sql(
        `INSERT INTO bottling_batches (id, winery_id, product_type, international_lot_code, final_alcohol_abv,
                                       total_bottles_packaged, packaging_format_cl, bottling_date, lot_id,
                                       blockchain_anchor_tx_hash, is_anchored_on_chain, anchored_at, blockchain_data_hash)
         VALUES ($1::uuid, $2::uuid, 'SINGANI', $3, 40, 1200, 75, '2026-09-15', $4::uuid, $5, $6, $7, $8)`,
        BATCH[key],
        WINERY,
        `ANC-2026-SINGANI-${key}-${run.slice(-6)}`,
        lots[key],
        anchor.hash,
        anchor.flag,
        anchor.at,
        DATA_HASH,
      );
    await insertBatch('simulated', {
      hash: SIMULATED_HASH,
      flag: true,
      at: ANCHORED_AT,
    });
    await insertBatch('hashOnly', { hash: HASH_ONLY, flag: false, at: null });
    await insertBatch('flagOnly', { hash: null, flag: true, at: ANCHORED_AT });
    await insertBatch('clean', { hash: null, flag: false, at: null });
    await insertBatch('real', { hash: REAL_TX, flag: true, at: ANCHORED_AT });
    // El anclaje confirmado del último: su expediente y su fila en `dossier_anchors`
    await sql(
      `INSERT INTO lot_dossiers (lot_id, status, hash, closed_at) VALUES ($1::uuid, 'CLOSED', $2, now())`,
      lots.real,
      'e'.repeat(64),
    );
    await sql(
      `INSERT INTO dossier_anchors (id, lot_id, status, network, account, memo_hash_hex, tx_hash, ledger, anchored_at, verified_at)
       VALUES ($1::uuid, $2::uuid, 'ANCHORED', 'TESTNET', $3, $4, $5, 1234, $6, $6)`,
      randomUUID(),
      lots.real,
      `G${'A'.repeat(55)}`,
      'e'.repeat(64),
      REAL_TX,
      ANCHORED_AT,
    );
    // Un anclaje sin confirmar no protege a su embotellado
    await sql(
      `INSERT INTO lot_dossiers (lot_id, status, hash, closed_at) VALUES ($1::uuid, 'CLOSED', $2, now())`,
      lots.simulated,
      'f'.repeat(64),
    );
    await sql(
      `INSERT INTO dossier_anchors (id, lot_id, status, network, account, memo_hash_hex)
       VALUES ($1::uuid, $2::uuid, 'PENDING', 'TESTNET', $3, $4)`,
      randomUUID(),
      lots.simulated,
      `G${'A'.repeat(55)}`,
      'f'.repeat(64),
    );
    expect(await count('bottling_batches')).toBe(5);

    // 3. La migración, sobre esas filas
    const applied = migrate(['deploy']);
    expect({ status: applied.status, output: applied.output }).toMatchObject({
      status: 0,
    });
  }, 240_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      await prisma.$disconnect();
    }
    rmSync(before, { recursive: true, force: true });
  });

  it('el anclaje simulado se mueve a la columna legada y el embotellado queda sin anclar', async () => {
    expect(await batch(BATCH.simulated)).toMatchObject({
      blockchain_anchor_tx_hash: null,
      is_anchored_on_chain: false,
      anchored_at: null,
      legacy_simulated_anchor_tx_hash: SIMULATED_HASH,
    });
    expect(await batch(BATCH.hashOnly)).toMatchObject({
      blockchain_anchor_tx_hash: null,
      is_anchored_on_chain: false,
      anchored_at: null,
      legacy_simulated_anchor_tx_hash: HASH_ONLY,
    });
    // Solo la marca: no había hash que conservar, pero deja de figurar anclado
    expect(await batch(BATCH.flagOnly)).toMatchObject({
      blockchain_anchor_tx_hash: null,
      is_anchored_on_chain: false,
      anchored_at: null,
      legacy_simulated_anchor_tx_hash: null,
    });
  });

  it('lo que nunca se ancló no cambia, y un anclaje confirmado en la red se respeta', async () => {
    expect(await batch(BATCH.clean)).toMatchObject({
      blockchain_anchor_tx_hash: null,
      is_anchored_on_chain: false,
      anchored_at: null,
      legacy_simulated_anchor_tx_hash: null,
    });
    const real = await batch(BATCH.real);
    expect(real).toMatchObject({
      blockchain_anchor_tx_hash: REAL_TX,
      is_anchored_on_chain: true,
      legacy_simulated_anchor_tx_hash: null,
    });
    expect(real.anchored_at?.toISOString()).toBe(ANCHORED_AT.toISOString());
  });

  it('no borra nada: mismas filas y el resto de sus datos intacto', async () => {
    expect(await count('bottling_batches')).toBe(5);
    expect(await count('lots')).toBe(5);
    expect(await count('dossier_anchors')).toBe(2);
    for (const id of Object.values(BATCH)) {
      expect(await batch(id)).toMatchObject({
        blockchain_data_hash: DATA_HASH,
        total_bottles_packaged: 1200,
      });
    }
    // El cliente generado lee las filas migradas
    const viaClient = await prisma.bottlingBatch.findUniqueOrThrow({
      where: { id: BATCH.simulated },
    });
    expect(viaClient).toMatchObject({
      isAnchoredOnChain: false,
      blockchainAnchorTxHash: null,
      legacySimulatedAnchorTxHash: SIMULATED_HASH,
    });
  });

  it('repetirla no hace nada (ya aplicada)', async () => {
    const again = migrate(['deploy']);
    expect(again.status).toBe(0);
    expect(again.output).toMatch(/No pending migrations to apply/);
    const applied = await rows<{ migration_name: string }>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    );
    expect(applied.map((m) => m.migration_name)).toContain(MIGRATION);
  });
});
