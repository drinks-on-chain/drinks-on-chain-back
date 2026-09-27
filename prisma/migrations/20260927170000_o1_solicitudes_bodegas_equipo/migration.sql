-- Ola 1 · 1.3–1.6 (contrato O1 §3–§5): solicitudes de alta, ruta pública,
-- prefijo de lote y activación de las bodegas, historial de estados.
-- Aditiva; al final rellena los datos de las bodegas existentes.

-- CreateEnum
CREATE TYPE "winery_application_status_enum" AS ENUM ('UNVERIFIED', 'RECEIVED', 'IN_REVIEW', 'MEETING_SCHEDULED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "meeting_channel_enum" AS ENUM ('CALL', 'VIDEO', 'IN_PERSON');

-- AlterTable
ALTER TABLE "wineries" ADD COLUMN     "activated_at" TIMESTAMPTZ(6),
ADD COLUMN     "lot_prefix" VARCHAR(5),
ADD COLUMN     "public_story" TEXT,
ADD COLUMN     "slug" VARCHAR(120),
ADD COLUMN     "website" VARCHAR(500);

-- CreateTable
CREATE TABLE "winery_applications" (
    "id" UUID NOT NULL,
    "status" "winery_application_status_enum" NOT NULL DEFAULT 'UNVERIFIED',
    "legal_name" VARCHAR(300) NOT NULL,
    "trade_name" VARCHAR(300) NOT NULL,
    "tax_id" VARCHAR(20) NOT NULL,
    "category" "winery_category_enum" NOT NULL,
    "region" VARCHAR(120) NOT NULL,
    "contact_name" VARCHAR(200) NOT NULL,
    "contact_email" VARCHAR(255) NOT NULL,
    "contact_phone" VARCHAR(30),
    "message" TEXT,
    "verify_token_hash" CHAR(64),
    "verify_expires_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "submitted_ip" VARCHAR(64),
    "assignee_user_id" UUID,
    "assignee_name" VARCHAR(200),
    "meeting_scheduled_at" TIMESTAMPTZ(6),
    "meeting_channel" "meeting_channel_enum",
    "meeting_notes" TEXT,
    "decision_by_user_id" UUID,
    "decision_by_name" VARCHAR(200),
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason" TEXT,
    "winery_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "winery_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "winery_application_notes" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "author_user_id" UUID,
    "author_name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "winery_application_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "winery_status_changes" (
    "id" UUID NOT NULL,
    "winery_id" UUID NOT NULL,
    "status" "winery_status_enum" NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_user_id" UUID,
    "by_name" VARCHAR(200) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "winery_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "winery_applications_verify_token_hash_key" ON "winery_applications"("verify_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "winery_applications_winery_id_key" ON "winery_applications"("winery_id");

-- CreateIndex
CREATE INDEX "winery_applications_status_created_at_idx" ON "winery_applications"("status", "created_at");

-- CreateIndex
CREATE INDEX "winery_applications_tax_id_idx" ON "winery_applications"("tax_id");

-- CreateIndex
CREATE INDEX "winery_applications_contact_email_created_at_idx" ON "winery_applications"("contact_email", "created_at");

-- CreateIndex
CREATE INDEX "winery_applications_submitted_ip_created_at_idx" ON "winery_applications"("submitted_ip", "created_at");

-- CreateIndex
CREATE INDEX "winery_applications_assignee_user_id_idx" ON "winery_applications"("assignee_user_id");

-- CreateIndex
CREATE INDEX "winery_application_notes_application_id_created_at_idx" ON "winery_application_notes"("application_id", "created_at");

-- CreateIndex
CREATE INDEX "winery_status_changes_winery_id_changed_at_idx" ON "winery_status_changes"("winery_id", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "wineries_slug_key" ON "wineries"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "wineries_lot_prefix_key" ON "wineries"("lot_prefix");

-- AddForeignKey
ALTER TABLE "winery_applications" ADD CONSTRAINT "winery_applications_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "winery_applications" ADD CONSTRAINT "winery_applications_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "winery_application_notes" ADD CONSTRAINT "winery_application_notes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "winery_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "winery_status_changes" ADD CONSTRAINT "winery_status_changes_winery_id_fkey" FOREIGN KEY ("winery_id") REFERENCES "wineries"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Formato del prefijo de lote: 3–5 letras mayúsculas
ALTER TABLE "wineries" ADD CONSTRAINT "wineries_lot_prefix_format" CHECK ("lot_prefix" ~ '^[A-Z]{3,5}$');

-- -----------------------------------------------------------------------------
-- Datos de las bodegas existentes (funciones auxiliares temporales)
-- -----------------------------------------------------------------------------
CREATE FUNCTION doc_tmp_unaccent(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(t,
    'áàäâãÁÀÄÂÃéèëêÉÈËÊíìïîÍÌÏÎóòöôõÓÒÖÔÕúùüûÚÙÜÛñÑçÇ',
    'aaaaaAAAAAeeeeEEEEiiiiIIIIoooooOOOOOuuuuUUUUnNcC')
$$;

-- Mismo criterio que src/modules/wineries/winery-identity.ts#slugify
CREATE FUNCTION doc_tmp_slugify(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(nullif(left(regexp_replace(
    regexp_replace(
      regexp_replace(lower(doc_tmp_unaccent(name)), '[^a-z0-9]+', '-', 'g'),
      '(^-+|-+$)', '', 'g'),
    '^bodegas?-', ''), 100), ''), 'bodega')
$$;

-- Mismo criterio que src/modules/wineries/winery-identity.ts#deriveLotPrefix
CREATE FUNCTION doc_tmp_lot_prefix(name text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  words text[];
  pool text[];
  w text;
  last_word text;
  base text := '';
  letters text := '';
  i int;
  res text[];
BEGIN
  SELECT coalesce(array_agg(x), '{}') INTO words
    FROM unnest(regexp_split_to_array(upper(doc_tmp_unaccent(name)), '[^A-Z]+')) AS x
    WHERE x <> '';
  SELECT coalesce(array_agg(x), '{}') INTO pool
    FROM unnest(words) AS x
    WHERE x NOT IN ('DE','DEL','LA','LAS','LOS','EL','Y','E',
                    'BODEGA','BODEGAS','DESTILERIA','VINEDOS','VINEDO','VINAS','CASA','CERVECERIA','FINCA');
  IF cardinality(pool) = 0 THEN pool := words; END IF;
  IF cardinality(pool) = 0 THEN pool := ARRAY['DOC']; END IF;
  last_word := pool[cardinality(pool)];
  IF cardinality(pool) = 1 THEN
    base := left(last_word, 3);
  ELSE
    FOREACH w IN ARRAY pool LOOP base := base || left(w, 1); END LOOP;
    base := left(base, 3);
  END IF;
  i := 2;
  WHILE length(base) < 3 AND i <= length(last_word) LOOP
    base := base || substr(last_word, i, 1);
    i := i + 1;
  END LOOP;
  base := rpad(base, 3, 'X');
  FOREACH w IN ARRAY pool LOOP letters := letters || w; END LOOP;
  res := ARRAY[base, left(base || substr(letters, 4), 4), left(base || substr(letters, 4), 5)];
  FOR i IN 65..90 LOOP res := res || (left(base, 2) || chr(i)); END LOOP;
  RETURN res;
END
$$;

DO $$
DECLARE
  r record;
  candidate text;
  slug_base text;
  slug_value text;
  n int;
BEGIN
  -- Slug de todas las bodegas (las más antiguas se quedan el nombre limpio)
  FOR r IN SELECT id, commercial_name FROM wineries WHERE slug IS NULL ORDER BY created_at, id LOOP
    slug_base := doc_tmp_slugify(r.commercial_name);
    slug_value := slug_base;
    n := 2;
    WHILE EXISTS (SELECT 1 FROM wineries WHERE slug = slug_value) LOOP
      slug_value := slug_base || '-' || n;
      n := n + 1;
    END LOOP;
    UPDATE wineries SET slug = slug_value WHERE id = r.id;
  END LOOP;

  -- Prefijo de lote de las bodegas ya activadas (o con embotellados): primero
  -- el que ya usan en sus códigos de lote (p. ej. ALT, CVJ), después el derivado
  FOR r IN
    SELECT w.id, w.commercial_name,
      (SELECT split_part(b.international_lot_code, '-', 1)
         FROM bottling_batches b
        WHERE b.winery_id = w.id
          AND split_part(b.international_lot_code, '-', 1) ~ '^[A-Z]{3,5}$'
        GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1) AS used
    FROM wineries w
    WHERE w.lot_prefix IS NULL
      AND (w.certification_status IN ('ACTIVE', 'SUSPENDED')
           OR EXISTS (SELECT 1 FROM bottling_batches b WHERE b.winery_id = w.id))
    ORDER BY (SELECT count(*) FROM bottling_batches b WHERE b.winery_id = w.id) DESC, w.created_at, w.id
  LOOP
    candidate := NULL;
    IF r.used IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wineries WHERE lot_prefix = r.used) THEN
      candidate := r.used;
    ELSE
      SELECT c INTO candidate
        FROM unnest(doc_tmp_lot_prefix(r.commercial_name)) WITH ORDINALITY AS t(c, ord)
       WHERE c ~ '^[A-Z]{3,5}$' AND NOT EXISTS (SELECT 1 FROM wineries WHERE lot_prefix = c)
       ORDER BY ord LIMIT 1;
    END IF;
    IF candidate IS NULL THEN
      RAISE EXCEPTION 'Sin prefijo de lote libre para la bodega %', r.id;
    END IF;
    UPDATE wineries
       SET lot_prefix = candidate,
           activated_at = coalesce(activated_at, approved_at, created_at)
     WHERE id = r.id;
  END LOOP;
END
$$;

-- Historial inicial: alta y estado actual
INSERT INTO winery_status_changes (id, winery_id, status, changed_at, by_name)
SELECT gen_random_uuid(), id, 'INVITED', created_at, 'Sistema' FROM wineries;
INSERT INTO winery_status_changes (id, winery_id, status, changed_at, by_name)
SELECT gen_random_uuid(), id, certification_status, greatest(coalesce(approved_at, updated_at), created_at), 'Sistema'
  FROM wineries WHERE certification_status <> 'INVITED';

DROP FUNCTION doc_tmp_lot_prefix(text);
DROP FUNCTION doc_tmp_slugify(text);
DROP FUNCTION doc_tmp_unaccent(text);
