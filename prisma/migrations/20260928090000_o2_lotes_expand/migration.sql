-- Ola 2 · apertura (O2-BE-1): migración *expand* del lote (contrato O2 §1, §2.6).
-- Todo es aditivo: tablas nuevas y columnas nulas. Se relajan dos restricciones
-- únicas: el código de vendimia pasa a ser único por bodega (su secuencia es
-- por bodega, EA-07) y un embotellado admite varios análisis (reanálisis, §8).

-- CreateEnum
CREATE TYPE "lot_stage_enum" AS ENUM ('ORIGIN', 'HARVEST', 'FERMENTING', 'AGING', 'DISTILLING', 'RESTING', 'BOTTLED', 'CERTIFIED', 'ANCHORED', 'REJECTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "lot_product_type_enum" AS ENUM ('WINE', 'SINGANI');

-- CreateEnum
CREATE TYPE "bottle_unit_status_enum" AS ENUM ('ACTIVE', 'VOIDED');

-- DropIndex
DROP INDEX "batch_lab_analyses_bottling_batch_id_key";

-- DropIndex
DROP INDEX "harvest_batches_harvest_batch_code_key";

-- AlterTable
ALTER TABLE "batch_lab_analyses" ADD COLUMN     "conformity" JSONB,
ADD COLUMN     "conformity_status" VARCHAR(20),
ADD COLUMN     "created_by_membership_id" UUID,
ADD COLUMN     "laboratory_report_key" VARCHAR(500),
ADD COLUMN     "lot_id" UUID,
ADD COLUMN     "methanol_mg_100ml_aa" DECIMAL(9,3),
ADD COLUMN     "superseded_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "bottling_batches" ADD COLUMN     "available_liters" DECIMAL(12,3),
ADD COLUMN     "created_by_membership_id" UUID,
ADD COLUMN     "label_design_key" VARCHAR(500),
ADD COLUMN     "leftover_disposition" VARCHAR(20),
ADD COLUMN     "leftover_liters" DECIMAL(12,3),
ADD COLUMN     "leftover_notes" TEXT,
ADD COLUMN     "lot_id" UUID;

-- AlterTable
ALTER TABLE "fermentation_tanks" ADD COLUMN     "created_by_membership_id" UUID,
ADD COLUMN     "final_volume_liters" DECIMAL(12,2),
ADD COLUMN     "lot_id" UUID;

-- AlterTable
ALTER TABLE "harvest_batches" ADD COLUMN     "created_by_membership_id" UUID,
ADD COLUMN     "lot_id" UUID,
ADD COLUMN     "terroir_snapshot" JSONB,
ALTER COLUMN "brix_degrees" DROP NOT NULL,
ALTER COLUMN "initial_ph" DROP NOT NULL,
ALTER COLUMN "initial_acidity_gl" DROP NOT NULL;

-- AlterTable
ALTER TABLE "production_batches" ADD COLUMN     "created_by_membership_id" UUID,
ADD COLUMN     "discard_reason" TEXT,
ADD COLUMN     "discarded_at" TIMESTAMPTZ(6),
ADD COLUMN     "heads_liters" DECIMAL(10,3),
ADD COLUMN     "heart_abv_percent" DECIMAL(5,2),
ADD COLUMN     "heart_liters" DECIMAL(10,3),
ADD COLUMN     "lot_id" UUID,
ADD COLUMN     "tails_liters" DECIMAL(10,3),
ADD COLUMN     "vinasse_liters" DECIMAL(10,3);

-- AlterTable
ALTER TABLE "wine_aging_batches" ADD COLUMN     "container_count" INTEGER,
ADD COLUMN     "created_by_membership_id" UUID,
ADD COLUMN     "discard_reason" TEXT,
ADD COLUMN     "discarded_at" TIMESTAMPTZ(6),
ADD COLUMN     "lot_id" UUID,
ADD COLUMN     "start_date" DATE;

-- CreateTable
CREATE TABLE "lots" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "reference" VARCHAR(40) NOT NULL,
    "lot_code" VARCHAR(100),
    "name" VARCHAR(120) NOT NULL,
    "product_type" "lot_product_type_enum",
    "stage" "lot_stage_enum" NOT NULL DEFAULT 'ORIGIN',
    "stage_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "harvest_year" SMALLINT NOT NULL,
    "estimated_bottles" INTEGER,
    "planned_format_cl" INTEGER,
    "target_abv_percent" DECIMAL(5,2),
    "target_ready_date" DATE,
    "planned_terroir_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "rules" JSONB NOT NULL,
    "rules_origin" VARCHAR(20) NOT NULL,
    "notes" TEXT,
    "discarded_at" TIMESTAMPTZ(6),
    "discarded_by_membership_id" UUID,
    "discard_reason" TEXT,
    "created_by_membership_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_events" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stage" "lot_stage_enum" NOT NULL,
    "actor_membership_id" UUID,
    "summary" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "resource_type" VARCHAR(40) NOT NULL,
    "resource_id" VARCHAR(100) NOT NULL,
    "visibility" VARCHAR(10) NOT NULL DEFAULT 'INTERNAL',
    "corrected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "lot_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_sequences" (
    "winery_id" UUID NOT NULL,
    "year" SMALLINT NOT NULL,
    "scope" VARCHAR(30) NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_sequences_pkey" PRIMARY KEY ("winery_id","year","scope")
);

-- CreateTable
CREATE TABLE "phyto_decisions" (
    "id" UUID NOT NULL,
    "harvest_batch_id" UUID NOT NULL,
    "decision" "phyto_status_enum" NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_membership_id" UUID,
    "inspection_report_key" VARCHAR(500),
    "inspection_report_sha256" CHAR(64),
    "notes" TEXT,
    "source" VARCHAR(20) NOT NULL DEFAULT 'ERP',
    "voided_at" TIMESTAMPTZ(6),

    CONSTRAINT "phyto_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maturity_analyses" (
    "id" UUID NOT NULL,
    "harvest_batch_id" UUID NOT NULL,
    "brix_degrees" DECIMAL(5,2) NOT NULL,
    "ph" DECIMAL(4,2) NOT NULL,
    "acidity_gl" DECIMAL(6,3) NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_membership_id" UUID,
    "notes" TEXT,
    "source" VARCHAR(20) NOT NULL DEFAULT 'ERP',
    "voided_at" TIMESTAMPTZ(6),

    CONSTRAINT "maturity_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fermentation_tank_inputs" (
    "id" UUID NOT NULL,
    "fermentation_tank_id" UUID NOT NULL,
    "harvest_batch_id" UUID NOT NULL,
    "kg" DECIMAL(12,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fermentation_tank_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bottle_units" (
    "id" UUID NOT NULL,
    "code" CHAR(8) NOT NULL,
    "serial" INTEGER NOT NULL,
    "lot_id" UUID NOT NULL,
    "bottling_batch_id" UUID NOT NULL,
    "status" "bottle_unit_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "salt" CHAR(32) NOT NULL,
    "voided_at" TIMESTAMPTZ(6),
    "voided_by_membership_id" UUID,
    "void_reason" TEXT,
    "replaced_by_code" CHAR(8),
    "replaces_code" CHAR(8),
    "exports_count" INTEGER NOT NULL DEFAULT 0,
    "first_exported_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bottle_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bottle_code_exports" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "format" VARCHAR(10) NOT NULL,
    "from_serial" INTEGER,
    "to_serial" INTEGER,
    "options" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "rows" INTEGER NOT NULL DEFAULT 0,
    "storage_key" VARCHAR(500),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_membership_id" UUID,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "bottle_code_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trace_corrections" (
    "id" UUID NOT NULL,
    "lot_id" UUID,
    "winery_id" UUID NOT NULL,
    "target_type" VARCHAR(30) NOT NULL,
    "target_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_membership_id" UUID,

    CONSTRAINT "trace_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_compliance_issues" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "message" TEXT NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '[]',
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_correction_id" UUID,

    CONSTRAINT "lot_compliance_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_attachments" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "key" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(100),
    "size_bytes" INTEGER,
    "sha256" CHAR(64),
    "visibility" VARCHAR(10) NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_membership_id" UUID,

    CONSTRAINT "lot_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_dossiers" (
    "lot_id" UUID NOT NULL,
    "schema" VARCHAR(30) NOT NULL DEFAULT 'doc-dossier/1',
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "hash" CHAR(64),
    "canonical" TEXT,
    "bottle_count" INTEGER,
    "bottle_merkle_root" CHAR(64),
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_membership_id" UUID,

    CONSTRAINT "lot_dossiers_pkey" PRIMARY KEY ("lot_id")
);

-- CreateTable
CREATE TABLE "lot_backfill_pending" (
    "harvest_batch_id" UUID NOT NULL,
    "enqueued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "lot_backfill_pending_pkey" PRIMARY KEY ("harvest_batch_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lots_reference_key" ON "lots"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "lots_lot_code_key" ON "lots"("lot_code");

-- CreateIndex
CREATE INDEX "lots_winery_id_stage_idx" ON "lots"("winery_id", "stage");

-- CreateIndex
CREATE INDEX "lots_winery_id_updated_at_idx" ON "lots"("winery_id", "updated_at");

-- CreateIndex
CREATE INDEX "lot_events_lot_id_occurred_at_idx" ON "lot_events"("lot_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "lot_events_lot_id_seq_key" ON "lot_events"("lot_id", "seq");

-- CreateIndex
CREATE INDEX "phyto_decisions_harvest_batch_id_recorded_at_idx" ON "phyto_decisions"("harvest_batch_id", "recorded_at");

-- CreateIndex
CREATE INDEX "maturity_analyses_harvest_batch_id_measured_at_idx" ON "maturity_analyses"("harvest_batch_id", "measured_at");

-- CreateIndex
CREATE INDEX "fermentation_tank_inputs_harvest_batch_id_idx" ON "fermentation_tank_inputs"("harvest_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "fermentation_tank_inputs_fermentation_tank_id_harvest_batch_key" ON "fermentation_tank_inputs"("fermentation_tank_id", "harvest_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "bottle_units_code_key" ON "bottle_units"("code");

-- CreateIndex
CREATE INDEX "bottle_units_lot_id_serial_idx" ON "bottle_units"("lot_id", "serial");

-- CreateIndex
CREATE INDEX "bottle_units_lot_id_status_idx" ON "bottle_units"("lot_id", "status");

-- CreateIndex
CREATE INDEX "bottle_code_exports_lot_id_created_at_idx" ON "bottle_code_exports"("lot_id", "created_at");

-- CreateIndex
CREATE INDEX "trace_corrections_lot_id_created_at_idx" ON "trace_corrections"("lot_id", "created_at");

-- CreateIndex
CREATE INDEX "trace_corrections_target_type_target_id_idx" ON "trace_corrections"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "lot_compliance_issues_lot_id_resolved_at_idx" ON "lot_compliance_issues"("lot_id", "resolved_at");

-- CreateIndex
CREATE INDEX "lot_attachments_lot_id_created_at_idx" ON "lot_attachments"("lot_id", "created_at");

-- CreateIndex
CREATE INDEX "batch_lab_analyses_bottling_batch_id_created_at_idx" ON "batch_lab_analyses"("bottling_batch_id", "created_at");

-- CreateIndex
CREATE INDEX "batch_lab_analyses_lot_id_idx" ON "batch_lab_analyses"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "bottling_batches_lot_id_key" ON "bottling_batches"("lot_id");

-- CreateIndex
CREATE INDEX "fermentation_tanks_lot_id_idx" ON "fermentation_tanks"("lot_id");

-- CreateIndex
CREATE INDEX "harvest_batches_lot_id_idx" ON "harvest_batches"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "harvest_batches_winery_id_harvest_batch_code_key" ON "harvest_batches"("winery_id", "harvest_batch_code");

-- CreateIndex
CREATE INDEX "production_batches_lot_id_idx" ON "production_batches"("lot_id");

-- CreateIndex
CREATE INDEX "wine_aging_batches_lot_id_idx" ON "wine_aging_batches"("lot_id");

-- AddForeignKey
ALTER TABLE "harvest_batches" ADD CONSTRAINT "harvest_batches_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_tanks" ADD CONSTRAINT "fermentation_tanks_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wine_aging_batches" ADD CONSTRAINT "wine_aging_batches_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_lab_analyses" ADD CONSTRAINT "batch_lab_analyses_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_events" ADD CONSTRAINT "lot_events_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_sequences" ADD CONSTRAINT "lot_sequences_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phyto_decisions" ADD CONSTRAINT "phyto_decisions_harvest_batch_id_fkey" FOREIGN KEY ("harvest_batch_id") REFERENCES "harvest_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maturity_analyses" ADD CONSTRAINT "maturity_analyses_harvest_batch_id_fkey" FOREIGN KEY ("harvest_batch_id") REFERENCES "harvest_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_tank_inputs" ADD CONSTRAINT "fermentation_tank_inputs_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_tank_inputs" ADD CONSTRAINT "fermentation_tank_inputs_harvest_batch_id_fkey" FOREIGN KEY ("harvest_batch_id") REFERENCES "harvest_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_units" ADD CONSTRAINT "bottle_units_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_units" ADD CONSTRAINT "bottle_units_bottling_batch_id_fkey" FOREIGN KEY ("bottling_batch_id") REFERENCES "bottling_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_code_exports" ADD CONSTRAINT "bottle_code_exports_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_corrections" ADD CONSTRAINT "trace_corrections_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_compliance_issues" ADD CONSTRAINT "lot_compliance_issues_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_attachments" ADD CONSTRAINT "lot_attachments_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_dossiers" ADD CONSTRAINT "lot_dossiers_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Relleno de los datos existentes (§2.6): cada pesaje anterior a esta migración
-- queda en cola; la API crea su lote al arrancar (LotBackfillRunner: un lote por
-- pesaje con UUID v5, instantánea MIGRATION, dictámenes, análisis de madurez,
-- entradas de tanque, conformidad de laboratorio, códigos de botella e
-- incidencias de cumplimiento). Los pesajes creados después pueden no tener
-- lote (uva recibida sin lote) y no se encolan.
INSERT INTO "lot_backfill_pending" ("harvest_batch_id")
SELECT "id" FROM "harvest_batches";
