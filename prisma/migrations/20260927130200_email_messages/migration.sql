-- CreateEnum
CREATE TYPE "email_status_enum" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200),
    "template" VARCHAR(100) NOT NULL,
    "to_address" VARCHAR(255) NOT NULL,
    "locale" VARCHAR(5) NOT NULL DEFAULT 'es',
    "variables" JSONB,
    "subject" VARCHAR(300),
    "status" "email_status_enum" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_message_id" VARCHAR(300),
    "organization_id" UUID,
    "correlation_id" VARCHAR(100),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_idempotency_key_key" ON "email_messages"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_messages_status_created_at_idx" ON "email_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "email_messages_to_address_created_at_idx" ON "email_messages"("to_address", "created_at");
