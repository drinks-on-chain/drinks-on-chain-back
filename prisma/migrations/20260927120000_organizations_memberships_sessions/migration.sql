-- Ola 0 · 0.5 y 0.6: organizaciones, membresías y sesiones (contrato O0 §4–§5)
-- y estado de la bodega INVITED (contrato O1 §0).
--
-- Aditiva y de datos: no borra columnas ni tablas. `users.user_role` y
-- `winery_members` se conservan (obsoletos, se retiran en H1).
--   · PENDING → INVITED en el estado de la bodega (renombrado del valor).
--   · Organización de plataforma "Drinks on Chain" (id fijo).
--   · Una organización WINERY por bodega (mismo id que la bodega).
--   · PLATFORM_ADMIN → membresía SUPERADMIN de la organización de plataforma.
--   · winery_members → membresías WINERY con el mismo id y rol
--     (is_active = false → BLOCKED por la plataforma).
--   · POS_OPERATOR y consumidores: sin membresía.

-- AlterEnum: PENDING → INVITED conservando las filas
ALTER TYPE "winery_status_enum" RENAME VALUE 'PENDING' TO 'INVITED';
ALTER TABLE "wineries" ALTER COLUMN "certification_status" SET DEFAULT 'INVITED';

-- CreateEnum
CREATE TYPE "organization_type_enum" AS ENUM ('PLATFORM', 'WINERY', 'PICKUP_POINT');

-- CreateEnum
CREATE TYPE "organization_status_enum" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "membership_role_enum" AS ENUM ('SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT', 'OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT', 'MANAGER', 'CASHIER');

-- CreateEnum
CREATE TYPE "membership_status_enum" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "membership_blocked_by_enum" AS ENUM ('OWNER', 'PLATFORM');

-- CreateEnum
CREATE TYPE "audience_enum" AS ENUM ('STAFF', 'CONSUMER');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_organization_id" UUID;

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "type" "organization_type_enum" NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "status" "organization_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "winery_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" "membership_role_enum" NOT NULL,
    "status" "membership_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "blocked_by" "membership_blocked_by_enum",
    "blocked_reason" VARCHAR(500),
    "blocked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "active_organization_id" UUID,
    "audience" "audience_enum" NOT NULL,
    "refresh_token_hash" VARCHAR(64) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "rotated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" VARCHAR(50),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(300),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_winery_id_key" ON "organizations"("winery_id");

-- CreateIndex
CREATE INDEX "organizations_type_idx" ON "organizations"("type");

-- CreateIndex
CREATE INDEX "memberships_organization_id_status_idx" ON "memberships"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_organization_id_key" ON "memberships"("user_id", "organization_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_active_organization_id_revoked_at_idx" ON "sessions"("active_organization_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_last_organization_id_fkey" FOREIGN KEY ("last_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_fkey" FOREIGN KEY ("active_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Datos ──────────────────────────────────────────────────────────────────

-- Organización de plataforma (id fijo: src/modules/organizations/organization.constants.ts)
INSERT INTO "organizations" ("id", "type", "name", "status")
VALUES ('00000000-0000-4000-8000-000000000001', 'PLATFORM', 'Drinks on Chain', 'ACTIVE')
ON CONFLICT ("id") DO NOTHING;

-- Una organización WINERY por bodega, con el mismo id, nombre comercial y estado
INSERT INTO "organizations" ("id", "type", "name", "status", "winery_id", "created_at")
SELECT w."id", 'WINERY', w."commercial_name",
       w."certification_status"::text::"organization_status_enum", w."id", w."created_at"
FROM "wineries" w
ON CONFLICT ("id") DO NOTHING;

-- PLATFORM_ADMIN → SUPERADMIN de la plataforma
INSERT INTO "memberships" ("id", "user_id", "organization_id", "role", "status", "blocked_by", "blocked_at", "created_at")
SELECT gen_random_uuid(), u."id", '00000000-0000-4000-8000-000000000001', 'SUPERADMIN',
       CASE WHEN u."is_active" THEN 'ACTIVE' ELSE 'BLOCKED' END::"membership_status_enum",
       CASE WHEN u."is_active" THEN NULL ELSE 'PLATFORM' END::"membership_blocked_by_enum",
       CASE WHEN u."is_active" THEN NULL ELSE CURRENT_TIMESTAMP END,
       u."created_at"
FROM "users" u
WHERE u."user_role" = 'PLATFORM_ADMIN'
ON CONFLICT ("user_id", "organization_id") DO NOTHING;

-- winery_members → membresías WINERY (mismo id: autoría de la trazabilidad)
INSERT INTO "memberships" ("id", "user_id", "organization_id", "role", "status", "blocked_by", "blocked_at", "created_at")
SELECT wm."id", wm."user_id", wm."winery_id", wm."member_role"::text::"membership_role_enum",
       CASE WHEN wm."is_active" THEN 'ACTIVE' ELSE 'BLOCKED' END::"membership_status_enum",
       CASE WHEN wm."is_active" THEN NULL ELSE 'PLATFORM' END::"membership_blocked_by_enum",
       CASE WHEN wm."is_active" THEN NULL ELSE CURRENT_TIMESTAMP END,
       wm."joined_at"
FROM "winery_members" wm
ON CONFLICT ("user_id", "organization_id") DO NOTHING;
