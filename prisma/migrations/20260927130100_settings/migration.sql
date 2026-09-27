-- CreateEnum
CREATE TYPE "setting_type_enum" AS ENUM ('NUMBER', 'BOOLEAN', 'STRING', 'LIST', 'OBJECT', 'NUMBER_OR_UNLIMITED', 'ENUM');

-- CreateEnum
CREATE TYPE "setting_levels_enum" AS ENUM ('GLOBAL', 'GLOBAL_AND_WINERY', 'WINERY');

-- CreateEnum
CREATE TYPE "setting_applies_at_enum" AS ENUM ('LOT', 'COLLECTION', 'IMMEDIATE');

-- CreateEnum
CREATE TYPE "setting_scope_enum" AS ENUM ('GLOBAL', 'WINERY');

-- CreateTable
CREATE TABLE "setting_definitions" (
    "key" VARCHAR(150) NOT NULL,
    "description" TEXT NOT NULL,
    "type" "setting_type_enum" NOT NULL,
    "enum_values" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unit" VARCHAR(30),
    "levels" "setting_levels_enum" NOT NULL,
    "applies_at" "setting_applies_at_enum" NOT NULL,
    "default_value" JSONB,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "integer" BOOLEAN NOT NULL DEFAULT false,
    "nullable" BOOLEAN NOT NULL DEFAULT false,
    "legal_minimum" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_definitions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "setting_global_values" (
    "key" VARCHAR(150) NOT NULL,
    "value" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "setting_global_values_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "setting_overrides" (
    "id" UUID NOT NULL,
    "key" VARCHAR(150) NOT NULL,
    "winery_id" UUID NOT NULL,
    "value" JSONB,
    "legal_exception" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "setting_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_changes" (
    "id" UUID NOT NULL,
    "key" VARCHAR(150) NOT NULL,
    "scope" "setting_scope_enum" NOT NULL,
    "winery_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT NOT NULL,
    "legal_exception" BOOLEAN NOT NULL DEFAULT false,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" UUID,
    "correlation_id" VARCHAR(100),

    CONSTRAINT "setting_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "setting_overrides_winery_id_idx" ON "setting_overrides"("winery_id");

-- CreateIndex
CREATE UNIQUE INDEX "setting_overrides_key_winery_id_key" ON "setting_overrides"("key", "winery_id");

-- CreateIndex
CREATE INDEX "setting_changes_key_changed_at_idx" ON "setting_changes"("key", "changed_at");

-- CreateIndex
CREATE INDEX "setting_changes_winery_id_changed_at_idx" ON "setting_changes"("winery_id", "changed_at");

-- AddForeignKey
ALTER TABLE "setting_global_values" ADD CONSTRAINT "setting_global_values_key_fkey" FOREIGN KEY ("key") REFERENCES "setting_definitions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "setting_overrides" ADD CONSTRAINT "setting_overrides_key_fkey" FOREIGN KEY ("key") REFERENCES "setting_definitions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "setting_overrides" ADD CONSTRAINT "setting_overrides_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
