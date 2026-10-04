-- Ola 2 · cierre H2 (O2-BE-1): migración *contract* del lote (contrato O2 §1,
-- §2.6.9, §9, §16). Endurece lo que la apertura dejó abierto:
--
--   1. `lot_id NOT NULL` en tanques, crianzas, destilaciones, embotellados y
--      análisis de laboratorio. El pesaje es la única tabla de la cadena con el
--      lote opcional (uva recibida sin lote).
--   2. Las 18 claves foráneas de la cadena anterior a la Ola 2 que borraban
--      (`CASCADE`) o desenganchaban (`SET NULL`) pasan a `RESTRICT`: ningún
--      registro de trazabilidad desaparece ni pierde su origen o su autor por
--      borrar otro (fin de las cascadas, §9).
--   3. Una serie de botella con un solo código activo (índice único parcial,
--      invariante de §7.1) e índices de las claves por las que se consulta la
--      cadena.
--   4. `laboratory_report_sha256`: huella del informe de laboratorio subido
--      (aditiva).
--
-- PostgreSQL ejecuta este archivo como una sola transacción: si una
-- comprobación falla, no se aplica nada. La migración queda entonces marcada
-- como fallida; tras corregir los datos:
--
--   prisma migrate resolve --rolled-back 20261002180000_o2_contraer_h2
--   prisma migrate deploy
--
-- Compatible con la versión anterior de la API (un rollback de la imagen no
-- necesita revertirla): esa versión ya asigna el lote a todo lo que crea y no
-- borra trazabilidad. `lot_backfill_pending` se conserva vacía por la misma
-- razón (la versión anterior la consulta) y se retirará en una ola posterior.

-- ── 0. Comprobaciones previas ────────────────────────────────────────────────
-- Registros de la cadena sin lote: el relleno de la apertura (§2.6) no terminó
-- o alguien escribió fuera de la API. No se corrige solo.
DO $$
DECLARE
  tanks        bigint;
  agings       bigint;
  distillations bigint;
  bottlings    bigint;
  analyses     bigint;
  pending      bigint;
BEGIN
  SELECT count(*) INTO tanks FROM "fermentation_tanks" WHERE "lot_id" IS NULL;
  SELECT count(*) INTO agings FROM "wine_aging_batches" WHERE "lot_id" IS NULL;
  SELECT count(*) INTO distillations FROM "production_batches" WHERE "lot_id" IS NULL;
  SELECT count(*) INTO bottlings FROM "bottling_batches" WHERE "lot_id" IS NULL;
  SELECT count(*) INTO analyses FROM "batch_lab_analyses" WHERE "lot_id" IS NULL;
  SELECT count(*) INTO pending FROM "lot_backfill_pending";
  IF tanks + agings + distillations + bottlings + analyses > 0 THEN
    RAISE EXCEPTION
      'Contracción H2 (o2_contraer_h2): quedan registros de trazabilidad sin lote: % tanques, % crianzas, % destilaciones, % embotellados y % análisis de laboratorio (% pesajes en lot_backfill_pending). Completa el relleno de la apertura (arranca la versión anterior de la API: LotBackfillRunner) o revisa lot_backfill_pending.last_error; después: prisma migrate resolve --rolled-back 20261002180000_o2_contraer_h2 y vuelve a desplegar. Un embotellado adicional de un lote ya embotellado (TRC_LOT_ALREADY_BOTTLED en las incidencias de la migración) no tiene lote: decide con la bodega cuál vale antes de contraer.',
      tanks, agings, distillations, bottlings, analyses, pending
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- Una serie con dos códigos activos rompería el índice único de abajo (y la
-- invariante «códigos activos = botellas», §7.1).
DO $$
DECLARE
  duplicated bigint;
BEGIN
  SELECT count(*) INTO duplicated FROM (
    SELECT 1 FROM "bottle_units" WHERE "status" = 'ACTIVE'
    GROUP BY "lot_id", "serial" HAVING count(*) > 1
  ) AS d;
  IF duplicated > 0 THEN
    RAISE EXCEPTION
      'Contracción H2 (o2_contraer_h2): % series de botella tienen más de un código activo. Anula los sobrantes (POST /v1/bottle-codes/{code}/void) y vuelve a desplegar tras: prisma migrate resolve --rolled-back 20261002180000_o2_contraer_h2',
      duplicated
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ── 1. El lote es obligatorio (salvo en el pesaje) ───────────────────────────
ALTER TABLE "fermentation_tanks" ALTER COLUMN "lot_id" SET NOT NULL;
ALTER TABLE "wine_aging_batches" ALTER COLUMN "lot_id" SET NOT NULL;
ALTER TABLE "production_batches" ALTER COLUMN "lot_id" SET NOT NULL;
ALTER TABLE "bottling_batches" ALTER COLUMN "lot_id" SET NOT NULL;
ALTER TABLE "batch_lab_analyses" ALTER COLUMN "lot_id" SET NOT NULL;

-- ── 4. Huella del informe de laboratorio ─────────────────────────────────────
ALTER TABLE "batch_lab_analyses" ADD COLUMN "laboratory_report_sha256" CHAR(64);

-- ── 2. Fin de las cascadas: CASCADE y SET NULL → RESTRICT ────────────────────
-- DropForeignKey
ALTER TABLE "batch_lab_analyses" DROP CONSTRAINT "batch_lab_analyses_bottling_batch_id_fkey";

-- DropForeignKey
ALTER TABLE "batch_lab_analyses" DROP CONSTRAINT "batch_lab_analyses_reviewed_by_member_id_fkey";

-- DropForeignKey
ALTER TABLE "bottling_batches" DROP CONSTRAINT "bottling_batches_production_batch_id_fkey";

-- DropForeignKey
ALTER TABLE "bottling_batches" DROP CONSTRAINT "bottling_batches_released_by_member_id_fkey";

-- DropForeignKey
ALTER TABLE "bottling_batches" DROP CONSTRAINT "bottling_batches_wine_aging_batch_id_fkey";

-- DropForeignKey
ALTER TABLE "bottling_batches" DROP CONSTRAINT "bottling_batches_winery_id_fkey";

-- DropForeignKey
ALTER TABLE "enological_treatments" DROP CONSTRAINT "enological_treatments_fermentation_tank_id_fkey";

-- DropForeignKey
ALTER TABLE "fermentation_logs" DROP CONSTRAINT "fermentation_logs_fermentation_tank_id_fkey";

-- DropForeignKey
ALTER TABLE "fermentation_tanks" DROP CONSTRAINT "fermentation_tanks_harvest_batch_id_fkey";

-- DropForeignKey
ALTER TABLE "fermentation_tanks" DROP CONSTRAINT "fermentation_tanks_winery_id_fkey";

-- DropForeignKey
ALTER TABLE "harvest_batches" DROP CONSTRAINT "harvest_batches_certified_by_member_id_fkey";

-- DropForeignKey
ALTER TABLE "harvest_batches" DROP CONSTRAINT "harvest_batches_terroir_id_fkey";

-- DropForeignKey
ALTER TABLE "harvest_batches" DROP CONSTRAINT "harvest_batches_winery_id_fkey";

-- DropForeignKey
ALTER TABLE "production_batches" DROP CONSTRAINT "production_batches_fermentation_tank_id_fkey";

-- DropForeignKey
ALTER TABLE "production_batches" DROP CONSTRAINT "production_batches_winery_id_fkey";

-- DropForeignKey
ALTER TABLE "terroirs" DROP CONSTRAINT "terroirs_winery_id_fkey";

-- DropForeignKey
ALTER TABLE "wine_aging_batches" DROP CONSTRAINT "wine_aging_batches_fermentation_tank_id_fkey";

-- DropForeignKey
ALTER TABLE "wine_aging_batches" DROP CONSTRAINT "wine_aging_batches_winery_id_fkey";

-- AddForeignKey
ALTER TABLE "terroirs" ADD CONSTRAINT "terroirs_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harvest_batches" ADD CONSTRAINT "harvest_batches_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harvest_batches" ADD CONSTRAINT "harvest_batches_terroir_id_fkey" FOREIGN KEY ("terroir_id") REFERENCES "terroirs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harvest_batches" ADD CONSTRAINT "harvest_batches_certified_by_member_id_fkey" FOREIGN KEY ("certified_by_member_id") REFERENCES "winery_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_tanks" ADD CONSTRAINT "fermentation_tanks_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_tanks" ADD CONSTRAINT "fermentation_tanks_harvest_batch_id_fkey" FOREIGN KEY ("harvest_batch_id") REFERENCES "harvest_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_logs" ADD CONSTRAINT "fermentation_logs_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enological_treatments" ADD CONSTRAINT "enological_treatments_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wine_aging_batches" ADD CONSTRAINT "wine_aging_batches_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wine_aging_batches" ADD CONSTRAINT "wine_aging_batches_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_wine_aging_batch_id_fkey" FOREIGN KEY ("wine_aging_batch_id") REFERENCES "wine_aging_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_production_batch_id_fkey" FOREIGN KEY ("production_batch_id") REFERENCES "production_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_released_by_member_id_fkey" FOREIGN KEY ("released_by_member_id") REFERENCES "winery_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_lab_analyses" ADD CONSTRAINT "batch_lab_analyses_bottling_batch_id_fkey" FOREIGN KEY ("bottling_batch_id") REFERENCES "bottling_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_lab_analyses" ADD CONSTRAINT "batch_lab_analyses_reviewed_by_member_id_fkey" FOREIGN KEY ("reviewed_by_member_id") REFERENCES "winery_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 3. Índices ───────────────────────────────────────────────────────────────
-- Un solo código activo por serie y lote (un código sustituido y su sustituto
-- comparten serie: el anulado queda fuera del índice). Parcial: Prisma no lo
-- expresa en `schema.prisma` ni lo compara en `migrate diff`.
CREATE UNIQUE INDEX "bottle_units_lot_id_serial_active_key" ON "bottle_units"("lot_id", "serial") WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "bottle_units_bottling_batch_id_status_idx" ON "bottle_units"("bottling_batch_id", "status");

-- CreateIndex
CREATE INDEX "bottling_batches_winery_id_bottling_date_idx" ON "bottling_batches"("winery_id", "bottling_date");

-- CreateIndex
CREATE INDEX "bottling_batches_wine_aging_batch_id_idx" ON "bottling_batches"("wine_aging_batch_id");

-- CreateIndex
CREATE INDEX "bottling_batches_production_batch_id_idx" ON "bottling_batches"("production_batch_id");

-- CreateIndex
CREATE INDEX "enological_treatments_fermentation_tank_id_idx" ON "enological_treatments"("fermentation_tank_id");

-- CreateIndex
CREATE INDEX "fermentation_tanks_winery_id_tank_code_idx" ON "fermentation_tanks"("winery_id", "tank_code");

-- CreateIndex
CREATE INDEX "fermentation_tanks_harvest_batch_id_idx" ON "fermentation_tanks"("harvest_batch_id");

-- CreateIndex
CREATE INDEX "harvest_batches_terroir_id_idx" ON "harvest_batches"("terroir_id");

-- CreateIndex
CREATE INDEX "production_batches_winery_id_idx" ON "production_batches"("winery_id");

-- CreateIndex
CREATE INDEX "production_batches_fermentation_tank_id_idx" ON "production_batches"("fermentation_tank_id");

-- CreateIndex
CREATE INDEX "terroirs_winery_id_idx" ON "terroirs"("winery_id");

-- CreateIndex
CREATE INDEX "wine_aging_batches_winery_id_idx" ON "wine_aging_batches"("winery_id");
