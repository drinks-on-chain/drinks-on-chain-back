-- CreateEnum
CREATE TYPE "user_role_enum" AS ENUM ('PLATFORM_ADMIN', 'WINERY_ADMIN', 'ENOLOGIST', 'AGRONOMIST', 'CONSUMER', 'POS_OPERATOR');

-- CreateEnum
CREATE TYPE "winery_category_enum" AS ENUM ('WINERY', 'BREWERY', 'DISTILLERY', 'OTHER');

-- CreateEnum
CREATE TYPE "winery_status_enum" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "winery_member_role_enum" AS ENUM ('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT');

-- CreateEnum
CREATE TYPE "wallet_type_enum" AS ENUM ('CUSTODIAL', 'SELF_CUSTODY');

-- CreateEnum
CREATE TYPE "wallet_purpose_enum" AS ENUM ('CONSUMER_NFT', 'PRODUCER_SIGNING');

-- CreateEnum
CREATE TYPE "phyto_status_enum" AS ENUM ('PENDING_INSPECTION', 'APPROVED', 'REJECTED', 'QUARANTINE');

-- CreateEnum
CREATE TYPE "destination_type_enum" AS ENUM ('WINE_AGING', 'SINGANI_DIST', 'BEER_MATURATION', 'SPIRITS_DIST', 'OTHER');

-- CreateEnum
CREATE TYPE "tank_status_enum" AS ENUM ('FILLING', 'FERMENTING', 'COMPLETED', 'TRANSFERRED', 'CLEANED');

-- CreateEnum
CREATE TYPE "treatment_type_enum" AS ENUM ('ACIDITY_CORRECTION', 'SO2_ADDITION', 'CLARIFICATION', 'FILTRATION_AID', 'NUTRIENT_ADDITION', 'ENZYME_ADDITION', 'OAK_CHIPS', 'FINING_AGENT', 'STABILIZATION', 'OTHER');

-- CreateEnum
CREATE TYPE "aging_status_enum" AS ENUM ('AGING', 'READY', 'BOTTLED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "production_process_enum" AS ENUM ('SINGANI_DISTILLATION', 'SPIRITS_DISTILLATION', 'BEER_MATURATION', 'SECONDARY_FERMENTATION', 'OTHER');

-- CreateEnum
CREATE TYPE "rest_status_enum" AS ENUM ('NOT_REQUIRED', 'RESTING', 'READY', 'BOTTLED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "beverage_type_enum" AS ENUM ('WINE', 'SINGANI', 'BEER', 'SPIRITS', 'CIDER', 'MEAD', 'OTHER');

-- CreateTable
CREATE TABLE "system_health" (
    "id" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'OK',

    CONSTRAINT "system_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone_number" VARCHAR(20),
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "user_role" "user_role_enum" NOT NULL,
    "dynamic_user_id" VARCHAR(200),
    "preferred_locale" CHAR(2) NOT NULL DEFAULT 'es',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wineries" (
    "id" UUID NOT NULL,
    "legal_name" VARCHAR(300) NOT NULL,
    "commercial_name" VARCHAR(300) NOT NULL,
    "beverage_category" "winery_category_enum" NOT NULL,
    "tax_id_nit" VARCHAR(20) NOT NULL,
    "senasag_sanitary_reg" VARCHAR(50),
    "geographic_region" VARCHAR(100) NOT NULL,
    "country_code" CHAR(2) NOT NULL DEFAULT 'BO',
    "address" TEXT,
    "contact_email" VARCHAR(255) NOT NULL,
    "contact_phone" VARCHAR(20),
    "logo_url" VARCHAR(500),
    "stellar_public_key" VARCHAR(60),
    "dynamic_vault_id" VARCHAR(200),
    "onchain_producer_id" VARCHAR(100),
    "onchain_register_tx_hash" VARCHAR(100),
    "is_export_certified" BOOLEAN NOT NULL DEFAULT false,
    "certification_status" "winery_status_enum" NOT NULL DEFAULT 'PENDING',
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wineries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "winery_members" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "member_role" "winery_member_role_enum" NOT NULL,
    "professional_license_number" VARCHAR(100),
    "professional_license_pdf_url" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "winery_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "winery_id" UUID,
    "stellar_public_address" VARCHAR(60) NOT NULL,
    "dynamic_vault_id" VARCHAR(200) NOT NULL,
    "wallet_type" "wallet_type_enum" NOT NULL DEFAULT 'CUSTODIAL',
    "wallet_purpose" "wallet_purpose_enum" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terroirs" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "parcel_name" VARCHAR(200) NOT NULL,
    "cadastre_code" VARCHAR(50),
    "surface_hectares" DECIMAL(10,4) NOT NULL,
    "altitude_masl" DECIMAL(8,2) NOT NULL,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "geographic_polygon_geojson" JSONB,
    "raw_material_type" VARCHAR(100) NOT NULL,
    "variety_name" VARCHAR(200) NOT NULL,
    "soil_type" VARCHAR(100),
    "irrigation_system" VARCHAR(100),
    "is_do_eligible" BOOLEAN NOT NULL DEFAULT false,
    "do_type" VARCHAR(100),
    "do_certificate_url" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terroirs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harvest_batches" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "terroir_id" UUID NOT NULL,
    "harvest_batch_code" VARCHAR(50) NOT NULL,
    "intake_date" DATE NOT NULL,
    "harvest_year" SMALLINT NOT NULL,
    "gross_weight_kg" DECIMAL(12,3) NOT NULL,
    "tare_weight_kg" DECIMAL(12,3) NOT NULL,
    "net_weight_kg" DECIMAL(12,3) NOT NULL,
    "brix_degrees" DECIMAL(5,2) NOT NULL,
    "initial_ph" DECIMAL(4,2) NOT NULL,
    "initial_acidity_gl" DECIMAL(6,3) NOT NULL,
    "temperature_at_intake_c" DECIMAL(5,2),
    "phytosanitary_status" "phyto_status_enum" NOT NULL DEFAULT 'PENDING_INSPECTION',
    "phyto_inspection_pdf_url" VARCHAR(500),
    "certified_by_member_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harvest_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fermentation_tanks" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "harvest_batch_id" UUID NOT NULL,
    "tank_code" VARCHAR(50) NOT NULL,
    "capacity_liters" DECIMAL(12,2),
    "material" VARCHAR(50),
    "volume_filled_liters" DECIMAL(12,2),
    "destination_type" "destination_type_enum",
    "status" "tank_status_enum" NOT NULL DEFAULT 'FILLING',
    "start_date" TIMESTAMPTZ(6) NOT NULL,
    "end_date" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fermentation_tanks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fermentation_logs" (
    "id" UUID NOT NULL,
    "fermentation_tank_id" UUID NOT NULL,
    "temperature_celsius" DECIMAL(5,2) NOT NULL,
    "specific_gravity" DECIMAL(6,4),
    "ph_value" DECIMAL(4,2),
    "co2_observations" VARCHAR(100),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "notes" TEXT,

    CONSTRAINT "fermentation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enological_treatments" (
    "id" UUID NOT NULL,
    "fermentation_tank_id" UUID NOT NULL,
    "treatment_type" "treatment_type_enum" NOT NULL,
    "additive_name" VARCHAR(200) NOT NULL,
    "additive_supplier" VARCHAR(200),
    "dosage_applied_g_per_hl" DECIMAL(10,4) NOT NULL,
    "total_applied_g" DECIMAL(12,4),
    "regulatory_auth_code" VARCHAR(100) NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL,
    "authorized_by_member_id" UUID NOT NULL,
    "notes" TEXT,

    CONSTRAINT "enological_treatments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wine_aging_batches" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "fermentation_tank_id" UUID NOT NULL,
    "container_type" VARCHAR(100) NOT NULL,
    "container_material" VARCHAR(100),
    "container_code" VARCHAR(100),
    "barrel_use_cycle" INTEGER,
    "volume_liters" DECIMAL(12,2),
    "planned_months" INTEGER NOT NULL,
    "lock_until_date" DATE NOT NULL,
    "aging_status" "aging_status_enum" NOT NULL DEFAULT 'AGING',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wine_aging_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_batches" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "fermentation_tank_id" UUID NOT NULL,
    "process_type" "production_process_enum" NOT NULL,
    "equipment_identifier" VARCHAR(100) NOT NULL,
    "process_start_date" DATE NOT NULL,
    "process_end_date" DATE,
    "input_volume_liters" DECIMAL(10,3),
    "output_volume_liters" DECIMAL(10,3),
    "waste_volume_liters" DECIMAL(10,3),
    "initial_alcohol_percentage" DECIMAL(5,2),
    "is_do_eligible" BOOLEAN NOT NULL DEFAULT false,
    "mandatory_rest_until" DATE,
    "rest_status" "rest_status_enum" NOT NULL DEFAULT 'NOT_REQUIRED',
    "additional_params" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bottling_batches" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "wine_aging_batch_id" UUID,
    "production_batch_id" UUID,
    "product_type" "beverage_type_enum" NOT NULL,
    "international_lot_code" VARCHAR(100) NOT NULL,
    "final_alcohol_abv" DECIMAL(5,2) NOT NULL,
    "water_dilution_liters" DECIMAL(10,3),
    "total_bottles_packaged" INTEGER NOT NULL,
    "packaging_format_cl" INTEGER NOT NULL,
    "bottle_type" VARCHAR(100),
    "label_design_url" VARCHAR(500),
    "bottling_date" DATE NOT NULL,
    "released_by_member_id" UUID,
    "blockchain_anchor_tx_hash" VARCHAR(100),
    "blockchain_data_hash" CHAR(64),
    "is_anchored_on_chain" BOOLEAN NOT NULL DEFAULT false,
    "anchored_at" TIMESTAMPTZ(6),
    "qr_batch_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bottling_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_lab_analyses" (
    "id" UUID NOT NULL,
    "bottling_batch_id" UUID NOT NULL,
    "certified_laboratory_name" VARCHAR(300) NOT NULL,
    "accredited_lab_certification_code" VARCHAR(100) NOT NULL,
    "analysis_request_date" DATE,
    "test_performed_at" DATE NOT NULL,
    "actual_alcohol_abv" DECIMAL(5,2) NOT NULL,
    "total_alcohol_abv" DECIMAL(5,2),
    "total_acidity_tartaric_gl" DECIMAL(6,3) NOT NULL,
    "volatile_acidity_acetic_gl" DECIMAL(6,3) NOT NULL,
    "free_sulfur_dioxide_mg_l" DECIMAL(7,3),
    "total_sulfur_dioxide_mg_l" DECIMAL(7,3),
    "reducing_sugars_gl" DECIMAL(7,3),
    "total_dry_extract_gl" DECIMAL(7,3),
    "sugar_free_dry_extract_gl" DECIMAL(7,3),
    "overpressure_bar" DECIMAL(5,2),
    "methanol_content_mg_l" DECIMAL(7,3),
    "copper_content_mg_l" DECIMAL(7,3),
    "additional_params" JSONB,
    "laboratory_report_pdf_url" VARCHAR(500) NOT NULL,
    "conforms_to_senasag_standards" BOOLEAN NOT NULL DEFAULT false,
    "conforms_to_eu_standards" BOOLEAN NOT NULL DEFAULT false,
    "conforms_to_usa_standards" BOOLEAN NOT NULL DEFAULT false,
    "reviewed_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_lab_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "users_dynamic_user_id_key" ON "users"("dynamic_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wineries_tax_id_nit_key" ON "wineries"("tax_id_nit");

-- CreateIndex
CREATE UNIQUE INDEX "wineries_senasag_sanitary_reg_key" ON "wineries"("senasag_sanitary_reg");

-- CreateIndex
CREATE UNIQUE INDEX "wineries_stellar_public_key_key" ON "wineries"("stellar_public_key");

-- CreateIndex
CREATE UNIQUE INDEX "wineries_dynamic_vault_id_key" ON "wineries"("dynamic_vault_id");

-- CreateIndex
CREATE UNIQUE INDEX "wineries_onchain_producer_id_key" ON "wineries"("onchain_producer_id");

-- CreateIndex
CREATE UNIQUE INDEX "winery_members_user_id_winery_id_key" ON "winery_members"("user_id", "winery_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_wallets_stellar_public_address_key" ON "user_wallets"("stellar_public_address");

-- CreateIndex
CREATE UNIQUE INDEX "user_wallets_dynamic_vault_id_key" ON "user_wallets"("dynamic_vault_id");

-- CreateIndex
CREATE UNIQUE INDEX "harvest_batches_harvest_batch_code_key" ON "harvest_batches"("harvest_batch_code");

-- CreateIndex
CREATE INDEX "fermentation_logs_fermentation_tank_id_idx" ON "fermentation_logs"("fermentation_tank_id");

-- CreateIndex
CREATE INDEX "fermentation_logs_recorded_at_idx" ON "fermentation_logs"("recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "wine_aging_batches_fermentation_tank_id_key" ON "wine_aging_batches"("fermentation_tank_id");

-- CreateIndex
CREATE UNIQUE INDEX "bottling_batches_international_lot_code_key" ON "bottling_batches"("international_lot_code");

-- CreateIndex
CREATE UNIQUE INDEX "batch_lab_analyses_bottling_batch_id_key" ON "batch_lab_analyses"("bottling_batch_id");

-- AddForeignKey
ALTER TABLE "wineries" ADD CONSTRAINT "wineries_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "winery_members" ADD CONSTRAINT "winery_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "winery_members" ADD CONSTRAINT "winery_members_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terroirs" ADD CONSTRAINT "terroirs_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harvest_batches" ADD CONSTRAINT "harvest_batches_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harvest_batches" ADD CONSTRAINT "harvest_batches_terroir_id_fkey" FOREIGN KEY ("terroir_id") REFERENCES "terroirs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harvest_batches" ADD CONSTRAINT "harvest_batches_certified_by_member_id_fkey" FOREIGN KEY ("certified_by_member_id") REFERENCES "winery_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_tanks" ADD CONSTRAINT "fermentation_tanks_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_tanks" ADD CONSTRAINT "fermentation_tanks_harvest_batch_id_fkey" FOREIGN KEY ("harvest_batch_id") REFERENCES "harvest_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_logs" ADD CONSTRAINT "fermentation_logs_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fermentation_logs" ADD CONSTRAINT "fermentation_logs_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enological_treatments" ADD CONSTRAINT "enological_treatments_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enological_treatments" ADD CONSTRAINT "enological_treatments_authorized_by_member_id_fkey" FOREIGN KEY ("authorized_by_member_id") REFERENCES "winery_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wine_aging_batches" ADD CONSTRAINT "wine_aging_batches_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wine_aging_batches" ADD CONSTRAINT "wine_aging_batches_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_fermentation_tank_id_fkey" FOREIGN KEY ("fermentation_tank_id") REFERENCES "fermentation_tanks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_wine_aging_batch_id_fkey" FOREIGN KEY ("wine_aging_batch_id") REFERENCES "wine_aging_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_production_batch_id_fkey" FOREIGN KEY ("production_batch_id") REFERENCES "production_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottling_batches" ADD CONSTRAINT "bottling_batches_released_by_member_id_fkey" FOREIGN KEY ("released_by_member_id") REFERENCES "winery_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_lab_analyses" ADD CONSTRAINT "batch_lab_analyses_bottling_batch_id_fkey" FOREIGN KEY ("bottling_batch_id") REFERENCES "bottling_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_lab_analyses" ADD CONSTRAINT "batch_lab_analyses_reviewed_by_member_id_fkey" FOREIGN KEY ("reviewed_by_member_id") REFERENCES "winery_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
