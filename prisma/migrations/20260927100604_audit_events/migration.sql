-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_user_id" UUID,
    "actor_full_name" VARCHAR(200),
    "actor_role" VARCHAR(50),
    "actor_organization_id" UUID,
    "actor_via_platform" BOOLEAN NOT NULL DEFAULT false,
    "source_app" VARCHAR(20) NOT NULL,
    "source_ip" VARCHAR(64),
    "source_device_id" VARCHAR(100),
    "session_id" VARCHAR(100),
    "action" VARCHAR(100) NOT NULL,
    "resource_type" VARCHAR(100) NOT NULL,
    "resource_id" VARCHAR(100),
    "organization_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "correlation_id" VARCHAR(100),
    "hash" CHAR(64) NOT NULL,
    "prev_hash" CHAR(64),

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_seq_key" ON "audit_events"("seq");

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_seq_idx" ON "audit_events"("actor_user_id", "seq");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_seq_idx" ON "audit_events"("organization_id", "seq");

-- CreateIndex
CREATE INDEX "audit_events_action_seq_idx" ON "audit_events"("action", "seq");

-- CreateIndex
CREATE INDEX "audit_events_resource_type_resource_id_idx" ON "audit_events"("resource_type", "resource_id");

-- Integridad básica de la cadena
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_seq_positive" CHECK ("seq" > 0),
  ADD CONSTRAINT "audit_events_hash_hex" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "audit_events_prev_hash_hex" CHECK ("prev_hash" IS NULL OR "prev_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "audit_events_first_has_no_prev" CHECK (("seq" = 1) = ("prev_hash" IS NULL));

-- AUD-02: solo inserción. Nadie edita, borra ni vacía la bitácora, tampoco
-- el administrador desde la aplicación (docs-back/07 §4.3).
CREATE OR REPLACE FUNCTION "audit_events_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events es de solo inserción: % no permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_reject_change"();

CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_reject_change"();
