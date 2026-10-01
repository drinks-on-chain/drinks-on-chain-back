-- Ola 1 · lista de espera (contrato O1b; v0.1.1): inscripciones públicas de
-- consumidores (landing) y bodegas (sitio de bodegas).
-- Aditiva: solo crea dos tablas y sus tipos; no toca nada existente.

-- CreateEnum
CREATE TYPE "waitlist_type_enum" AS ENUM ('CONSUMER', 'WINERY');

-- CreateEnum
CREATE TYPE "waitlist_status_enum" AS ENUM ('NEW', 'CONTACTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "waitlist_interest_enum" AS ENUM ('WINE', 'SINGANI', 'BOTH');

-- CreateEnum
CREATE TYPE "waitlist_produces_enum" AS ENUM ('WINE', 'SINGANI', 'BOTH', 'OTHER');

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL,
    "type" "waitlist_type_enum" NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "waitlist_status_enum" NOT NULL DEFAULT 'NEW',
    "full_name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20),
    "city" VARCHAR(80),
    "interest" "waitlist_interest_enum",
    "winery_name" VARCHAR(160),
    "region" VARCHAR(80),
    "produces" "waitlist_produces_enum",
    "message" VARCHAR(500),
    "is_adult" BOOLEAN,
    "locale" VARCHAR(2) NOT NULL DEFAULT 'es',
    "source" VARCHAR(40),
    "consent_at" TIMESTAMPTZ(6) NOT NULL,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "contacted_at" TIMESTAMPTZ(6),
    "contacted_by_user_id" UUID,
    "contacted_by_name" VARCHAR(200),
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_counters" (
    "type" "waitlist_type_enum" NOT NULL,
    "last_position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "waitlist_counters_pkey" PRIMARY KEY ("type")
);

-- CreateIndex
CREATE INDEX "waitlist_entries_type_created_at_idx" ON "waitlist_entries"("type", "created_at");

-- CreateIndex
CREATE INDEX "waitlist_entries_type_status_idx" ON "waitlist_entries"("type", "status");

-- CreateIndex
CREATE INDEX "waitlist_entries_source_idx" ON "waitlist_entries"("source");

-- CreateIndex
CREATE INDEX "waitlist_entries_created_at_idx" ON "waitlist_entries"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_type_email_key" ON "waitlist_entries"("type", "email");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_type_position_key" ON "waitlist_entries"("type", "position");


-- Contadores de posición: una fila por tipo (se bloquea al inscribir)
INSERT INTO "waitlist_counters" ("type", "last_position") VALUES ('CONSUMER', 0), ('WINERY', 0);
