import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Migración *contract* del cierre H2 (`o2_contraer_h2`, contrato O2 §2.6.9)
 * sobre una base en el estado de la apertura (migraciones anteriores) con
 * datos: un lote completo, uva sin lote (legítima) y registros huérfanos.
 *
 * - Con registros de la cadena sin lote **falla con un mensaje claro y no
 *   aplica nada** (el archivo entero es una transacción).
 * - Tras corregir los datos y `migrate resolve --rolled-back`, se aplica.
 * - Después: `lot_id NOT NULL` salvo en el pesaje, claves foráneas `RESTRICT`
 *   (nada se borra ni se desengancha en cascada) y un solo código activo por
 *   serie de botella.
 */
const MIGRATION = '20261002180000_o2_contraer_h2';
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `contract_e2e_${run}`;

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}
const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);
const prismaCli = require.resolve('prisma/build/index.js');

/** `prisma migrate …` sobre el esquema de la prueba; devuelve la salida. */
function migrate(args: string[]): { status: number; output: string } {
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', ...args], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      // Esquema propio: sin el candado de migraciones de toda la base
      PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
    },
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

describe('Migración contract del cierre H2 (o2_contraer_h2)', () => {
  let prisma: PrismaClient;
  /** Copia de `prisma/` sin la migración contract: el estado de la apertura. */
  const before = mkdtempSync(join(tmpdir(), 'doc-contract-'));

  const WINERY = randomUUID();
  const TERROIR = randomUUID();
  const HARVEST = randomUUID();
  const LOOSE_HARVEST = randomUUID();
  const LOT = randomUUID();
  const TANK = randomUUID();
  const AGING = randomUUID();
  const BOTTLING = randomUUID();
  const ORPHAN_TANK = randomUUID();
  const ORPHAN_DISTILLATION = randomUUID();
  const DUPLICATED_UNIT = randomUUID();

  const sql = (query: string, ...values: unknown[]) =>
    prisma.$executeRawUnsafe(query, ...values);
  const rows = <T>(query: string, ...values: unknown[]) =>
    prisma.$queryRawUnsafe<T[]>(query, ...values);

  const lotIdNullable = async () =>
    Object.fromEntries(
      (
        await rows<{ table_name: string; is_nullable: string }>(
          `SELECT table_name, is_nullable FROM information_schema.columns
           WHERE table_schema = $1 AND column_name = 'lot_id'
             AND table_name IN ('harvest_batches', 'fermentation_tanks', 'wine_aging_batches',
                                'production_batches', 'bottling_batches', 'batch_lab_analyses')`,
          schema,
        )
      ).map((r) => [r.table_name, r.is_nullable]),
    );
  /** Regla de borrado de cada clave foránea de la cadena anterior a la Ola 2. */
  const deleteRules = async () =>
    rows<{ name: string; rule: string }>(
      `SELECT c.conname AS name, c.confdeltype::text AS rule
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = $1 AND c.contype = 'f'
         AND c.conrelid::regclass::text ~ '(terroirs|harvest_batches|fermentation_tanks|fermentation_logs|enological_treatments|wine_aging_batches|production_batches|bottling_batches|batch_lab_analyses)"?$'
       ORDER BY c.conname`,
      schema,
    );

  beforeAll(async () => {
    cpSync('prisma/schema.prisma', join(before, 'schema.prisma'));
    cpSync('prisma/migrations', join(before, 'migrations'), {
      recursive: true,
      filter: (source) => !source.includes(MIGRATION),
    });
    expect(readdirSync(join(before, 'migrations'))).not.toContain(MIGRATION);
    const opened = migrate([
      'deploy',
      '--schema',
      join(before, 'schema.prisma'),
    ]);
    expect(opened).toMatchObject({ status: 0 });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    // Datos en el estado de la apertura (SQL directo: el cliente generado ya
    // es el del esquema contraído)
    await sql(
      `INSERT INTO wineries (id, legal_name, commercial_name, beverage_category, tax_id_nit, geographic_region, contact_email)
       VALUES ($1::uuid, 'Bodega Contract S.R.L.', 'Bodega Contract', 'WINERY', $2, 'Tarija', 'contract@e2e.test')`,
      WINERY,
      `NIT-${run.slice(-12)}`,
    );
    await sql(
      `INSERT INTO terroirs (id, winery_id, parcel_name, surface_hectares, altitude_masl, raw_material_type, variety_name)
       VALUES ($1::uuid, $2::uuid, 'Parcela contract', 2, 1900, 'uva', 'Syrah')`,
      TERROIR,
      WINERY,
    );
    await sql(
      `INSERT INTO lots (id, winery_id, reference, name, harvest_year, rules, rules_origin)
       VALUES ($1::uuid, $2::uuid, $3, 'Lote contract', 2025, '{}'::jsonb, 'MIGRATION')`,
      LOT,
      WINERY,
      `CON-L2025-${run}`,
    );
    for (const [id, code, lot] of [
      [HARVEST, 'HARV-2025-CONTRACT-001', LOT],
      // Uva recibida sin lote: legítima antes y después de contraer
      [LOOSE_HARVEST, 'HARV-2025-CONTRACT-002', null],
    ] as const) {
      await sql(
        `INSERT INTO harvest_batches (id, winery_id, terroir_id, harvest_batch_code, intake_date, harvest_year, gross_weight_kg, tare_weight_kg, net_weight_kg, lot_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2025-03-01', 2025, 1100, 100, 1000, $5::uuid)`,
        id,
        WINERY,
        TERROIR,
        code,
        lot,
      );
    }
    for (const [id, code, harvest, lot] of [
      [TANK, 'TK-CON-1', HARVEST, LOT],
      // Huérfano: un tanque anterior a la Ola 2 que el relleno no alcanzó
      [ORPHAN_TANK, 'TK-CON-2', LOOSE_HARVEST, null],
    ] as const) {
      await sql(
        `INSERT INTO fermentation_tanks (id, winery_id, harvest_batch_id, tank_code, start_date, status, lot_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2025-03-02T12:00:00Z', 'TRANSFERRED', $5::uuid)`,
        id,
        WINERY,
        harvest,
        code,
        lot,
      );
    }
    await sql(
      `INSERT INTO production_batches (id, winery_id, fermentation_tank_id, process_type, equipment_identifier, process_start_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'SINGANI_DISTILLATION', 'AL-CON', '2025-04-01')`,
      ORPHAN_DISTILLATION,
      WINERY,
      ORPHAN_TANK,
    );
    await sql(
      `INSERT INTO wine_aging_batches (id, winery_id, fermentation_tank_id, container_type, planned_months, lock_until_date, aging_status, lot_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Barrica', 6, '2025-10-01', 'BOTTLED', $4::uuid)`,
      AGING,
      WINERY,
      TANK,
      LOT,
    );
    await sql(
      `INSERT INTO bottling_batches (id, winery_id, wine_aging_batch_id, product_type, international_lot_code, final_alcohol_abv, total_bottles_packaged, packaging_format_cl, bottling_date, lot_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'WINE', $4, 13.5, 2, 75, '2025-11-01', $5::uuid)`,
      BOTTLING,
      WINERY,
      AGING,
      `CON-2025-WINE-${run}`,
      LOT,
    );
    await sql(
      `INSERT INTO batch_lab_analyses (id, bottling_batch_id, certified_laboratory_name, accredited_lab_certification_code, test_performed_at, actual_alcohol_abv, total_acidity_tartaric_gl, volatile_acidity_acetic_gl, laboratory_report_pdf_url, lot_id)
       VALUES ($1::uuid, $2::uuid, 'Laboratorio contract', 'LAB-CON', '2025-11-03', 13.5, 5.5, 0.4, 'org/x/lab/informe.pdf', $3::uuid)`,
      randomUUID(),
      BOTTLING,
      LOT,
    );
    for (const [serial, code] of [
      [1, 'CONTRAC1'],
      [2, 'CONTRAC2'],
    ] as const) {
      await sql(
        `INSERT INTO bottle_units (id, code, serial, lot_id, bottling_batch_id, salt)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, repeat('a', 32))`,
        randomUUID(),
        code,
        serial,
        LOT,
        BOTTLING,
      );
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      await prisma.$disconnect();
    }
    rmSync(before, { recursive: true, force: true });
  });

  it('con registros de la cadena sin lote falla con un mensaje claro y no aplica nada', async () => {
    const failed = migrate(['deploy']);
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain(
      'quedan registros de trazabilidad sin lote: 1 tanques, 0 crianzas, 1 destilaciones, 0 embotellados y 0 análisis de laboratorio',
    );
    expect(failed.output).toContain(
      `prisma migrate resolve --rolled-back ${MIGRATION}`,
    );

    // Nada aplicado: ni NOT NULL, ni RESTRICT, ni la columna nueva
    expect(await lotIdNullable()).toEqual({
      harvest_batches: 'YES',
      fermentation_tanks: 'YES',
      wine_aging_batches: 'YES',
      production_batches: 'YES',
      bottling_batches: 'YES',
      batch_lab_analyses: 'YES',
    });
    const rules = await deleteRules();
    expect(rules.filter((r) => r.rule === 'c').length).toBeGreaterThan(10);
    await expect(
      rows(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'laboratory_report_sha256'`,
        schema,
      ),
    ).resolves.toEqual([]);

    // Prisma no reintenta una migración fallida: hay que resolverla
    const blocked = migrate(['deploy']);
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain('P3009');
  }, 120_000);

  it('una serie de botella con dos códigos activos también la detiene', async () => {
    // Los huérfanos pasan a un lote (lo que haría el relleno de la apertura)
    await sql(
      `UPDATE fermentation_tanks SET lot_id = $1::uuid WHERE id = $2::uuid`,
      LOT,
      ORPHAN_TANK,
    );
    await sql(
      `UPDATE production_batches SET lot_id = $1::uuid WHERE id = $2::uuid`,
      LOT,
      ORPHAN_DISTILLATION,
    );
    await sql(
      `INSERT INTO bottle_units (id, code, serial, lot_id, bottling_batch_id, salt)
       VALUES ($1::uuid, 'CONTRAC3', 1, $2::uuid, $3::uuid, repeat('b', 32))`,
      DUPLICATED_UNIT,
      LOT,
      BOTTLING,
    );
    expect(migrate(['resolve', '--rolled-back', MIGRATION]).status).toBe(0);

    const failed = migrate(['deploy']);
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain(
      '1 series de botella tienen más de un código activo',
    );
    expect((await lotIdNullable()).fermentation_tanks).toBe('YES');
  }, 120_000);

  it('con los datos corregidos se aplica: lote obligatorio salvo en el pesaje', async () => {
    // El código sobrante se anula (un sustituto comparte serie con el anulado)
    await sql(
      `UPDATE bottle_units SET status = 'VOIDED', voided_at = now() WHERE id = $1::uuid`,
      DUPLICATED_UNIT,
    );
    expect(migrate(['resolve', '--rolled-back', MIGRATION]).status).toBe(0);
    const applied = migrate(['deploy']);
    expect(applied).toMatchObject({ status: 0 });
    expect(applied.output).toContain(MIGRATION);
    // Y no queda nada pendiente
    expect(migrate(['deploy']).output).toContain('No pending migrations');

    expect(await lotIdNullable()).toEqual({
      // Uva recibida sin lote (contrato O2 §2.4): el único `lot_id` opcional
      harvest_batches: 'YES',
      fermentation_tanks: 'NO',
      wine_aging_batches: 'NO',
      production_batches: 'NO',
      bottling_batches: 'NO',
      batch_lab_analyses: 'NO',
    });
    await expect(
      prisma.harvestBatch.findUniqueOrThrow({ where: { id: LOOSE_HARVEST } }),
    ).resolves.toMatchObject({ lotId: null });
    await expect(
      sql(
        `INSERT INTO fermentation_tanks (id, winery_id, harvest_batch_id, tank_code, start_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'TK-CON-3', now())`,
        randomUUID(),
        WINERY,
        HARVEST,
      ),
    ).rejects.toThrow(/23502/); // not_null_violation: `lot_id` es obligatorio
    // La huella del informe de laboratorio (aditiva)
    await expect(
      prisma.batchLabAnalysis.findFirstOrThrow({ where: { lotId: LOT } }),
    ).resolves.toMatchObject({ laboratoryReportSha256: null });
  }, 120_000);

  it('fin de las cascadas: las claves de la cadena son RESTRICT y nada se borra por arrastre', async () => {
    const rules = await deleteRules();
    const old = rules.filter((r) => !r.name.endsWith('_lot_id_fkey'));
    expect(old.map((r) => r.name).sort()).toEqual(
      [
        'batch_lab_analyses_bottling_batch_id_fkey',
        'batch_lab_analyses_reviewed_by_member_id_fkey',
        'bottling_batches_production_batch_id_fkey',
        'bottling_batches_released_by_member_id_fkey',
        'bottling_batches_wine_aging_batch_id_fkey',
        'bottling_batches_winery_id_fkey',
        'enological_treatments_authorized_by_member_id_fkey',
        'enological_treatments_fermentation_tank_id_fkey',
        'fermentation_logs_fermentation_tank_id_fkey',
        'fermentation_logs_recorded_by_user_id_fkey',
        'fermentation_tanks_harvest_batch_id_fkey',
        'fermentation_tanks_winery_id_fkey',
        'harvest_batches_certified_by_member_id_fkey',
        'harvest_batches_terroir_id_fkey',
        'harvest_batches_winery_id_fkey',
        'production_batches_fermentation_tank_id_fkey',
        'production_batches_winery_id_fkey',
        'terroirs_winery_id_fkey',
        'wine_aging_batches_fermentation_tank_id_fkey',
        'wine_aging_batches_winery_id_fkey',
      ].sort(),
    );
    // 'r' = RESTRICT: ninguna borra (`c`) ni desengancha (`n`)
    expect(rules.filter((r) => r.rule !== 'r')).toEqual([]);

    // Borrar la bodega, la parcela, el pesaje, el tanque o la crianza: imposible
    for (const [table, id] of [
      ['wineries', WINERY],
      ['terroirs', TERROIR],
      ['harvest_batches', HARVEST],
      ['fermentation_tanks', TANK],
      ['wine_aging_batches', AGING],
      ['bottling_batches', BOTTLING],
      ['lots', LOT],
    ] as const) {
      await expect(
        sql(`DELETE FROM ${table} WHERE id = $1::uuid`, id),
      ).rejects.toThrow(/foreign key|violates/i);
    }
    await expect(
      prisma.bottlingBatch.findUniqueOrThrow({ where: { id: BOTTLING } }),
    ).resolves.toMatchObject({ wineAgingBatchId: AGING, lotId: LOT });
  });

  it('un solo código activo por serie de botella (índice único parcial)', async () => {
    const insert = (code: string, serial: number, status: string) =>
      sql(
        `INSERT INTO bottle_units (id, code, serial, lot_id, bottling_batch_id, salt, status)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, repeat('c', 32), $6::bottle_unit_status_enum)`,
        randomUUID(),
        code,
        serial,
        LOT,
        BOTTLING,
        status,
      );
    // unique_violation: ya hay un código activo con esa serie
    await expect(insert('CONTRAC4', 2, 'ACTIVE')).rejects.toThrow(
      /23505.*\(lot_id, serial\)/s,
    );
    // Un código anulado comparte serie con su sustituto
    await expect(insert('CONTRAC5', 2, 'VOIDED')).resolves.toBe(1);
  });
});
