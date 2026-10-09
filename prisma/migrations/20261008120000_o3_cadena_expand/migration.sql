-- Ola 3 · apertura (O3-BE-1): migración *expand* de la cadena y la tokenización
-- (contrato O3 §1 y §3.3, pasos 1–3). Todo es aditivo: 19 tablas nuevas y
-- columnas nulas; no se borra ninguna fila ni ninguna columna.
--
-- Sobre los datos existentes (SE-02):
--   1. `wineries`: los cuatro valores simulados (`stellar_public_key`,
--      `dynamic_vault_id`, `onchain_producer_id`, `onchain_register_tx_hash`:
--      direcciones sin clave) se copian a `legacy_simulated_address` (la
--      dirección) y a `legacy_simulated_data` (los cuatro, en JSON) y se ponen
--      a NULL. Las bodegas que no tenían ninguno no se tocan.
--   2. `user_wallets`: columna `status` con `INVALID_SIMULATED` en todas las
--      filas (y por defecto); nadie la lee ya. La tabla se borra en H3.
--   3. La entrada `CHAIN_SIMULATED_WALLETS_INVALIDATED` de la bitácora la
--      escribe la API al arrancar (`SimulatedWalletsAuditRunner`): la bitácora
--      va encadenada por hash y su trigger no admite escribirla desde SQL.
--
-- Las partes escritas a mano (datos, `CHECK` e índices parciales) están al
-- final; lo demás es la salida de `prisma migrate diff`.

-- AlterTable
ALTER TABLE "user_wallets" ADD COLUMN     "status" VARCHAR(20) NOT NULL DEFAULT 'INVALID_SIMULATED';

-- AlterTable
ALTER TABLE "wineries" ADD COLUMN     "chain_account_id" UUID,
ADD COLUMN     "legacy_simulated_address" VARCHAR(60),
ADD COLUMN     "legacy_simulated_data" JSONB;

-- CreateTable
CREATE TABLE "chain_accounts" (
    "id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "network" VARCHAR(10) NOT NULL,
    "winery_id" UUID,
    "address" VARCHAR(56),
    "custody_key_ref" VARCHAR(100) NOT NULL,
    "derivation_index" INTEGER,
    "home_domain" VARCHAR(255),
    "status" VARCHAR(20) NOT NULL DEFAULT 'NOT_PROVISIONED',
    "last_error" JSONB,
    "created_tx_id" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nft_contracts" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "chain_account_id" UUID NOT NULL,
    "network" VARCHAR(10) NOT NULL,
    "address" VARCHAR(56),
    "wasm_hash" CHAR(64) NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "symbol" VARCHAR(10) NOT NULL,
    "base_uri" VARCHAR(200) NOT NULL,
    "operator_address" VARCHAR(56) NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "deployed_tx_id" UUID,
    "deployed_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nft_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_transactions" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "network" VARCHAR(10) NOT NULL,
    "intent_key" VARCHAR(200) NOT NULL,
    "subject_type" VARCHAR(12) NOT NULL,
    "subject_id" VARCHAR(100) NOT NULL,
    "winery_id" UUID,
    "intent" JSONB NOT NULL DEFAULT '{}',
    "source_account" VARCHAR(56),
    "signers" JSONB NOT NULL DEFAULT '[]',
    "tx_hash" CHAR(64),
    "ledger" INTEGER,
    "confirmed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" JSONB,
    "fee_charged_stroops" BIGINT,
    "rent_fee_stroops" BIGINT,
    "max_fee_stroops" BIGINT,
    "result" JSONB,
    "next_attempt_at" TIMESTAMPTZ(6),
    "max_time" TIMESTAMPTZ(6),
    "requested_by_user_id" UUID,
    "requested_by_name" VARCHAR(200),
    "requested_source" VARCHAR(6) NOT NULL DEFAULT 'WORKER',
    "abandoned_at" TIMESTAMPTZ(6),
    "abandoned_by" VARCHAR(200),
    "abandon_reason" TEXT,
    "correlation_id" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_tx_attempts" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tx_hash" CHAR(64),
    "sequence" VARCHAR(20),
    "error_code" VARCHAR(60),
    "detail" TEXT,

    CONSTRAINT "chain_tx_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_events" (
    "id" UUID NOT NULL,
    "rpc_event_id" VARCHAR(100) NOT NULL,
    "network" VARCHAR(10) NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "winery_id" UUID,
    "ledger" INTEGER NOT NULL,
    "ledger_closed_at" TIMESTAMPTZ(6) NOT NULL,
    "tx_hash" CHAR(64) NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "topics" JSONB NOT NULL DEFAULT '[]',
    "data" JSONB NOT NULL DEFAULT '{}',
    "matched_transaction_id" UUID,
    "originated_by_system" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_cursors" (
    "network" VARCHAR(10) NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "cursor" VARCHAR(200),
    "last_ledger" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_cursors_pkey" PRIMARY KEY ("network","name")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(12) NOT NULL,
    "subject_id" VARCHAR(100),
    "trigger" VARCHAR(12) NOT NULL,
    "depth" VARCHAR(6) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "checks" INTEGER NOT NULL DEFAULT 0,
    "issues_opened" INTEGER NOT NULL DEFAULT 0,
    "issues_auto_resolved" INTEGER NOT NULL DEFAULT 0,
    "requested_by_user_id" UUID,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_alerts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "level" VARCHAR(10) NOT NULL,
    "subject_type" VARCHAR(20) NOT NULL,
    "subject_id" VARCHAR(100) NOT NULL,
    "winery_id" UUID,
    "expected" JSONB,
    "actual" JSONB,
    "message" TEXT NOT NULL,
    "run_id" UUID,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" VARCHAR(200),
    "resolution_note" TEXT,
    "resolved_auto" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "chain_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokenization_requests" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED',
    "quantity" INTEGER NOT NULL,
    "resulting_quota" INTEGER NOT NULL,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "assignee_user_id" UUID,
    "commercial_draft" JSONB NOT NULL DEFAULT '{}',
    "price_amount_minor" INTEGER,
    "price_currency" CHAR(3),
    "price_source" VARCHAR(20),
    "price_set_at" TIMESTAMPTZ(6),
    "price_set_by_user_id" UUID,
    "winery_notes" TEXT,
    "limits_at_submission" JSONB NOT NULL DEFAULT '{}',
    "publish_on_mint" BOOLEAN NOT NULL DEFAULT false,
    "decision_outcome" VARCHAR(10),
    "decision_at" TIMESTAMPTZ(6),
    "decision_reason" TEXT,
    "decision_by_user_id" UUID,
    "decision_by_system" BOOLEAN NOT NULL DEFAULT false,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_by_membership_id" UUID,
    "withdraw_reason" TEXT,
    "collection_id" UUID,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by_membership_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tokenization_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokenization_request_changes" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "status" VARCHAR(20),
    "message" TEXT,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resolved_at" TIMESTAMPTZ(6),
    "actor_user_id" UUID,
    "actor_membership_id" UUID,
    "actor_name" VARCHAR(200),
    "actor_system" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tokenization_request_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(140) NOT NULL,
    "winery_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'MINTING',
    "mint_status" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "quota" INTEGER NOT NULL,
    "minted" INTEGER NOT NULL DEFAULT 0,
    "pending_mint_quantity" INTEGER NOT NULL DEFAULT 0,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL,
    "tasting_notes" TEXT,
    "pairing" TEXT,
    "estimated_redeem_date" DATE,
    "price_amount_minor" INTEGER,
    "price_currency" CHAR(3),
    "price_source" VARCHAR(20),
    "price_set_at" TIMESTAMPTZ(6),
    "price_set_by_user_id" UUID,
    "price_policy_snapshot" JSONB,
    "price_history" JSONB NOT NULL DEFAULT '[]',
    "redeemable" BOOLEAN NOT NULL DEFAULT false,
    "redeemable_since" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_images" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "key" VARCHAR(500) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "alt" VARCHAR(300) NOT NULL,
    "is_cover" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_status_history" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "reason" TEXT,
    "actor_user_id" UUID,
    "actor_name" VARCHAR(200),
    "actor_system" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mints" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "lot_arg" VARCHAR(64) NOT NULL,
    "ranges" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "mints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "token_id" INTEGER NOT NULL,
    "bottle_number" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'MINTED',
    "owner_kind" VARCHAR(10) NOT NULL DEFAULT 'WINERY',
    "owner_address" VARCHAR(56) NOT NULL,
    "mint_id" UUID NOT NULL,
    "mint_tx_id" UUID,
    "sold_at" TIMESTAMPTZ(6),
    "redeemable_at" TIMESTAMPTZ(6),
    "redeem_window_ends_at" TIMESTAMPTZ(6),
    "burned_at" TIMESTAMPTZ(6),
    "burn_tx_id" UUID,
    "burn_reason" VARCHAR(16),
    "onchain_owner" VARCHAR(56),
    "onchain_burned" BOOLEAN NOT NULL DEFAULT false,
    "onchain_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_closures" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bottles" INTEGER NOT NULL,
    "minted" INTEGER NOT NULL,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "unsold" INTEGER NOT NULL DEFAULT 0,
    "shortfall" INTEGER NOT NULL DEFAULT 0,
    "unsold_to_burn" INTEGER NOT NULL DEFAULT 0,
    "sold_without_bottle" INTEGER NOT NULL DEFAULT 0,
    "unsold_policy" VARCHAR(12),
    "decision_by_user_id" UUID,
    "decision_by_name" VARCHAR(200),
    "decision_at" TIMESTAMPTZ(6),
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_closure_items" (
    "id" UUID NOT NULL,
    "closure_id" UUID NOT NULL,
    "token_row_id" UUID NOT NULL,
    "token_id" INTEGER NOT NULL,
    "bottle_number" INTEGER NOT NULL,
    "token_status" VARCHAR(12) NOT NULL,
    "order_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "outcome" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "burn_tx_id" UUID,
    "note" TEXT,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "lot_closure_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dossier_anchors" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "network" VARCHAR(10) NOT NULL,
    "account" VARCHAR(56) NOT NULL,
    "memo_hash_hex" CHAR(64) NOT NULL,
    "tx_hash" CHAR(64),
    "ledger" INTEGER,
    "anchored_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "transaction_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dossier_anchors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_addresses" (
    "user_id" UUID NOT NULL,
    "index" SERIAL NOT NULL,
    "address" VARCHAR(56) NOT NULL,
    "derivation_path" VARCHAR(40) NOT NULL,
    "network" VARCHAR(10) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumer_addresses_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "chain_accounts_role_network_idx" ON "chain_accounts"("role", "network");

-- CreateIndex
CREATE UNIQUE INDEX "chain_accounts_network_address_key" ON "chain_accounts"("network", "address");

-- CreateIndex
CREATE UNIQUE INDEX "chain_accounts_network_custody_key_ref_key" ON "chain_accounts"("network", "custody_key_ref");

-- CreateIndex
CREATE UNIQUE INDEX "chain_accounts_network_derivation_index_key" ON "chain_accounts"("network", "derivation_index");

-- CreateIndex
CREATE UNIQUE INDEX "chain_accounts_winery_id_network_key" ON "chain_accounts"("winery_id", "network");

-- CreateIndex
CREATE INDEX "nft_contracts_winery_id_network_idx" ON "nft_contracts"("winery_id", "network");

-- CreateIndex
CREATE UNIQUE INDEX "nft_contracts_network_address_key" ON "nft_contracts"("network", "address");

-- CreateIndex
CREATE UNIQUE INDEX "chain_transactions_intent_key_key" ON "chain_transactions"("intent_key");

-- CreateIndex
CREATE INDEX "chain_transactions_status_next_attempt_at_idx" ON "chain_transactions"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "chain_transactions_kind_status_idx" ON "chain_transactions"("kind", "status");

-- CreateIndex
CREATE INDEX "chain_transactions_winery_id_created_at_idx" ON "chain_transactions"("winery_id", "created_at");

-- CreateIndex
CREATE INDEX "chain_transactions_subject_type_subject_id_idx" ON "chain_transactions"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "chain_transactions_tx_hash_idx" ON "chain_transactions"("tx_hash");

-- CreateIndex
CREATE INDEX "chain_transactions_created_at_idx" ON "chain_transactions"("created_at");

-- CreateIndex
CREATE INDEX "chain_tx_attempts_transaction_id_attempt_idx" ON "chain_tx_attempts"("transaction_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "chain_events_rpc_event_id_key" ON "chain_events"("rpc_event_id");

-- CreateIndex
CREATE INDEX "chain_events_contract_address_ledger_idx" ON "chain_events"("contract_address", "ledger");

-- CreateIndex
CREATE INDEX "chain_events_tx_hash_idx" ON "chain_events"("tx_hash");

-- CreateIndex
CREATE INDEX "chain_events_type_ledger_idx" ON "chain_events"("type", "ledger");

-- CreateIndex
CREATE INDEX "chain_events_originated_by_system_ledger_idx" ON "chain_events"("originated_by_system", "ledger");

-- CreateIndex
CREATE INDEX "reconciliation_runs_status_started_at_idx" ON "reconciliation_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "chain_alerts_resolved_at_level_idx" ON "chain_alerts"("resolved_at", "level");

-- CreateIndex
CREATE INDEX "chain_alerts_code_detected_at_idx" ON "chain_alerts"("code", "detected_at");

-- CreateIndex
CREATE INDEX "chain_alerts_winery_id_detected_at_idx" ON "chain_alerts"("winery_id", "detected_at");

-- CreateIndex
CREATE INDEX "tokenization_requests_winery_id_status_idx" ON "tokenization_requests"("winery_id", "status");

-- CreateIndex
CREATE INDEX "tokenization_requests_status_submitted_at_idx" ON "tokenization_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "tokenization_requests_lot_id_submitted_at_idx" ON "tokenization_requests"("lot_id", "submitted_at");

-- CreateIndex
CREATE INDEX "tokenization_requests_assignee_user_id_status_idx" ON "tokenization_requests"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "tokenization_request_changes_request_id_created_at_idx" ON "tokenization_request_changes"("request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "collections_slug_key" ON "collections"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "collections_lot_id_key" ON "collections"("lot_id");

-- CreateIndex
CREATE INDEX "collections_winery_id_status_idx" ON "collections"("winery_id", "status");

-- CreateIndex
CREATE INDEX "collections_status_published_at_idx" ON "collections"("status", "published_at");

-- CreateIndex
CREATE INDEX "collection_images_collection_id_position_idx" ON "collection_images"("collection_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "collection_images_collection_id_key_key" ON "collection_images"("collection_id", "key");

-- CreateIndex
CREATE INDEX "collection_status_history_collection_id_at_idx" ON "collection_status_history"("collection_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "mints_request_id_key" ON "mints"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "mints_collection_id_sequence_key" ON "mints"("collection_id", "sequence");

-- CreateIndex
CREATE INDEX "tokens_collection_id_status_idx" ON "tokens"("collection_id", "status");

-- CreateIndex
CREATE INDEX "tokens_owner_address_idx" ON "tokens"("owner_address");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_contract_id_token_id_key" ON "tokens"("contract_id", "token_id");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_collection_id_bottle_number_key" ON "tokens"("collection_id", "bottle_number");

-- CreateIndex
CREATE UNIQUE INDEX "lot_closures_lot_id_key" ON "lot_closures"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "lot_closures_collection_id_key" ON "lot_closures"("collection_id");

-- CreateIndex
CREATE INDEX "lot_closures_status_computed_at_idx" ON "lot_closures"("status", "computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "lot_closure_items_closure_id_token_id_key" ON "lot_closure_items"("closure_id", "token_id");

-- CreateIndex
CREATE UNIQUE INDEX "dossier_anchors_lot_id_key" ON "dossier_anchors"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "dossier_anchors_transaction_id_key" ON "dossier_anchors"("transaction_id");

-- CreateIndex
CREATE INDEX "dossier_anchors_status_idx" ON "dossier_anchors"("status");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_addresses_index_key" ON "consumer_addresses"("index");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_addresses_address_key" ON "consumer_addresses"("address");

-- CreateIndex
CREATE UNIQUE INDEX "wineries_chain_account_id_key" ON "wineries"("chain_account_id");

-- AddForeignKey
ALTER TABLE "wineries" ADD CONSTRAINT "wineries_chain_account_id_fkey" FOREIGN KEY ("chain_account_id") REFERENCES "chain_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_accounts" ADD CONSTRAINT "chain_accounts_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_contracts" ADD CONSTRAINT "nft_contracts_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_contracts" ADD CONSTRAINT "nft_contracts_chain_account_id_fkey" FOREIGN KEY ("chain_account_id") REFERENCES "chain_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_transactions" ADD CONSTRAINT "chain_transactions_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_tx_attempts" ADD CONSTRAINT "chain_tx_attempts_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "chain_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_events" ADD CONSTRAINT "chain_events_matched_transaction_id_fkey" FOREIGN KEY ("matched_transaction_id") REFERENCES "chain_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_alerts" ADD CONSTRAINT "chain_alerts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokenization_requests" ADD CONSTRAINT "tokenization_requests_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokenization_requests" ADD CONSTRAINT "tokenization_requests_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokenization_requests" ADD CONSTRAINT "tokenization_requests_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokenization_request_changes" ADD CONSTRAINT "tokenization_request_changes_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "tokenization_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "nft_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_images" ADD CONSTRAINT "collection_images_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_status_history" ADD CONSTRAINT "collection_status_history_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mints" ADD CONSTRAINT "mints_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mints" ADD CONSTRAINT "mints_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "tokenization_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "nft_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_mint_id_fkey" FOREIGN KEY ("mint_id") REFERENCES "mints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_closures" ADD CONSTRAINT "lot_closures_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_closures" ADD CONSTRAINT "lot_closures_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_closure_items" ADD CONSTRAINT "lot_closure_items_closure_id_fkey" FOREIGN KEY ("closure_id") REFERENCES "lot_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_closure_items" ADD CONSTRAINT "lot_closure_items_token_row_id_fkey" FOREIGN KEY ("token_row_id") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossier_anchors" ADD CONSTRAINT "dossier_anchors_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lot_dossiers"("lot_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossier_anchors" ADD CONSTRAINT "dossier_anchors_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "chain_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumer_addresses" ADD CONSTRAINT "consumer_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- A mano · invariantes en la base (contrato O3 §1; docs-back/03 §6, R6).
-- Prisma no expresa `CHECK` ni índices parciales, ni los compara en
-- `migrate diff`.
-- -----------------------------------------------------------------------------

-- R6: nunca más NFT emitidos que la cuota autorizada
ALTER TABLE "collections"
  ADD CONSTRAINT "collections_minted_lte_quota" CHECK ("minted" <= "quota"),
  ADD CONSTRAINT "collections_minted_non_negative" CHECK ("minted" >= 0),
  ADD CONSTRAINT "collections_quota_positive" CHECK ("quota" >= 1),
  ADD CONSTRAINT "collections_pending_mint_non_negative" CHECK ("pending_mint_quantity" >= 0),
  ADD CONSTRAINT "collections_price_positive" CHECK ("price_amount_minor" IS NULL OR "price_amount_minor" >= 1);

ALTER TABLE "tokenization_requests"
  ADD CONSTRAINT "tokenization_requests_quantity_positive" CHECK ("quantity" >= 1),
  ADD CONSTRAINT "tokenization_requests_resulting_quota" CHECK ("resulting_quota" >= "quantity"),
  ADD CONSTRAINT "tokenization_requests_price_positive" CHECK ("price_amount_minor" IS NULL OR "price_amount_minor" >= 1);

ALTER TABLE "mints"
  ADD CONSTRAINT "mints_quantity_positive" CHECK ("quantity" >= 1),
  ADD CONSTRAINT "mints_sequence_positive" CHECK ("sequence" >= 1);

ALTER TABLE "tokens"
  ADD CONSTRAINT "tokens_token_id_non_negative" CHECK ("token_id" >= 0),
  ADD CONSTRAINT "tokens_bottle_number_positive" CHECK ("bottle_number" >= 1);

-- Una cuenta de bodega tiene bodega; una de plataforma, no
ALTER TABLE "chain_accounts"
  ADD CONSTRAINT "chain_accounts_winery_by_role" CHECK (("role" = 'WINERY') = ("winery_id" IS NOT NULL)),
  ADD CONSTRAINT "chain_accounts_derivation_index_non_negative" CHECK ("derivation_index" IS NULL OR "derivation_index" >= 0);

-- El memo del anclaje son los 32 bytes de un SHA-256
ALTER TABLE "dossier_anchors"
  ADD CONSTRAINT "dossier_anchors_memo_hash_hex" CHECK ("memo_hash_hex" ~ '^[0-9a-f]{64}$');

-- El índice 0 de la semilla de consumidores queda reservado (S-9)
ALTER TABLE "consumer_addresses"
  ADD CONSTRAINT "consumer_addresses_index_positive" CHECK ("index" >= 1);

-- Una solicitud abierta por lote (§5.2.4 → 409 TOK_REQUEST_ALREADY_OPEN)
CREATE UNIQUE INDEX "tokenization_requests_lot_id_open_key" ON "tokenization_requests"("lot_id")
  WHERE "status" IN ('SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED');

-- Una cuenta de plataforma por papel y red
CREATE UNIQUE INDEX "chain_accounts_platform_role_network_key" ON "chain_accounts"("role", "network")
  WHERE "winery_id" IS NULL;

-- Un solo contrato vigente por bodega y red (§2.2, DEPLOY_WINERY_CONTRACT)
CREATE UNIQUE INDEX "nft_contracts_winery_id_network_current_key" ON "nft_contracts"("winery_id", "network")
  WHERE "status" <> 'RETIRED';

-- Una portada por colección
CREATE UNIQUE INDEX "collection_images_collection_id_cover_key" ON "collection_images"("collection_id")
  WHERE "is_cover";

-- Una conciliación en curso por alcance (→ 409 CHN_RECONCILIATION_RUNNING)
CREATE UNIQUE INDEX "reconciliation_runs_running_scope_key" ON "reconciliation_runs"("scope", COALESCE("subject_id", ''))
  WHERE "status" = 'RUNNING';

-- Una alerta abierta por código y sujeto (la conciliación no las duplica)
CREATE UNIQUE INDEX "chain_alerts_open_code_subject_key" ON "chain_alerts"("code", "subject_type", "subject_id")
  WHERE "resolved_at" IS NULL;

-- -----------------------------------------------------------------------------
-- A mano · SE-02 (contrato O3 §3.3, pasos 2 y 3). Sin `DELETE`: los valores
-- simulados se conservan en las columnas `legacy_*`.
-- -----------------------------------------------------------------------------

-- En un `UPDATE`, la parte derecha de cada asignación lee la fila anterior
UPDATE "wineries"
SET "legacy_simulated_address" = "stellar_public_key",
    "legacy_simulated_data" = jsonb_strip_nulls(jsonb_build_object(
      'stellarPublicKey', "stellar_public_key",
      'dynamicVaultId', "dynamic_vault_id",
      'onchainProducerId', "onchain_producer_id",
      'onchainRegisterTxHash', "onchain_register_tx_hash"
    )),
    "stellar_public_key" = NULL,
    "dynamic_vault_id" = NULL,
    "onchain_producer_id" = NULL,
    "onchain_register_tx_hash" = NULL
WHERE "stellar_public_key" IS NOT NULL
   OR "dynamic_vault_id" IS NOT NULL
   OR "onchain_producer_id" IS NOT NULL
   OR "onchain_register_tx_hash" IS NOT NULL;

-- La columna nace con `INVALID_SIMULATED` por defecto; explícito por si una
-- fila se insertó entre el `ALTER` y este punto con otro valor
UPDATE "user_wallets" SET "status" = 'INVALID_SIMULATED' WHERE "status" <> 'INVALID_SIMULATED';
