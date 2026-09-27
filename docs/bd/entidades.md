# Entidades de Base de Datos — Drinks on Chain

> **Motor:** PostgreSQL via Supabase  
> **Convenciones:** `snake_case` · UUIDs como PK · timestamps en UTC con zona · RLS habilitado en todas las tablas  
> **Extensiones requeridas:** `uuid-ossp`, `pgcrypto`, `pg_cron` (CRON jobs), `postgis` (polígonos GeoJSON — opcional MVP)  
> **Diseño:** Multi-tenant por `winery_id`. Genérico para cualquier tipo de bebida via `product_type`/`beverage_type`.

---

## Resumen de Entidades (27 tablas)

| Grupo | Tablas | MVP |
|---|---|---|
| Identidad y Acceso | `users`, `wineries`, `winery_members`, `user_wallets` | ✅ |
| Configuración | `enum_labels` | ✅ |
| Trazabilidad ERP | `terroirs`, `harvest_batches`, `fermentation_tanks`, `fermentation_logs`, `enological_treatments`, `wine_aging_batches`, `production_batches`, `bottling_batches`, `batch_lab_analyses` | ✅ |
| Exportación | `export_dossiers`, `export_dossier_items`, `export_documents_generated` | 🔜 Fase 2 (schema listo) |
| Tokenización | `collections`, `tokenized_items`, `blockchain_events` | ✅ |
| Órdenes y Pagos | `orders`, `order_items`, `payment_mint_retries` | ✅ |
| POS y Retiro | `pickup_locations`, `pos_shifts`, `claim_passes`, `claim_redemptions` | ✅ |
| Soporte | `support_tickets`, `audit_logs`, `indexer_state` | ✅ |

---

## Grupo 0 — Configuración Global

### `enum_labels`
*Traducciones de los valores de enums para internacionalización (ES/EN).*

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `uuid` PK | |
| `enum_name` | `varchar(100)` NOT NULL | Nombre del enum (ej. `beverage_type`) |
| `enum_value` | `varchar(100)` NOT NULL | Valor del enum (ej. `WINE`) |
| `locale` | `char(2)` NOT NULL | `es` o `en` |
| `label` | `varchar(200)` NOT NULL | Etiqueta traducida |
| `description` | `text` | Descripción larga opcional |

**UNIQUE:** `(enum_name, enum_value, locale)`

```sql
-- Datos de ejemplo
INSERT INTO enum_labels VALUES
  (gen_random_uuid(), 'beverage_type', 'WINE',    'es', 'Vino', NULL),
  (gen_random_uuid(), 'beverage_type', 'WINE',    'en', 'Wine', NULL),
  (gen_random_uuid(), 'beverage_type', 'SINGANI', 'es', 'Singani', 'Destilado boliviano de uva'),
  (gen_random_uuid(), 'beverage_type', 'SINGANI', 'en', 'Singani', 'Bolivian grape spirit'),
  (gen_random_uuid(), 'beverage_type', 'BEER',    'es', 'Cerveza', NULL),
  (gen_random_uuid(), 'beverage_type', 'BEER',    'en', 'Beer', NULL);
```

---

## Grupo 1 — Identidad y Acceso

### `users`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK, default `auth.uid()` | Sincronizado con Supabase Auth |
| `email` | `varchar(255)` | UNIQUE NOT NULL | |
| `phone_number` | `varchar(20)` | UNIQUE | Para autenticación MFA |
| `full_name` | `varchar(200)` | NOT NULL | |
| `user_role` | `user_role_enum` | NOT NULL | Ver enum abajo |
| `dynamic_user_id` | `varchar(200)` | UNIQUE | ID en Dynamic SDK |
| `preferred_locale` | `char(2)` | NOT NULL default `'es'` | `es` o `en` |
| `is_active` | `boolean` | NOT NULL default `true` | |
| `last_login_at` | `timestamptz` | | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |
| `updated_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
CREATE TYPE user_role_enum AS ENUM (
  'PLATFORM_ADMIN',  -- Debro Solutions — acceso total
  'WINERY_ADMIN',    -- Dueño/Gerente de bodega
  'ENOLOGIST',       -- Enólogo certificado (firma lotes)
  'AGRONOMIST',      -- Agrónomo de campo
  'CONSUMER',        -- Comprador B2C
  'POS_OPERATOR'     -- Operador de terminal POS
);
```

---

### `wineries`
*Multi-tenant root: winery_id es el tenant identifier en todo el sistema.*

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `legal_name` | `varchar(300)` | NOT NULL | Razón social |
| `commercial_name` | `varchar(300)` | NOT NULL | Marca comercial |
| `beverage_category` | `winery_category_enum` | NOT NULL | `WINERY`, `BREWERY`, `DISTILLERY`, `OTHER` |
| `tax_id_nit` | `varchar(20)` | UNIQUE NOT NULL | NIT boliviano |
| `senasag_sanitary_reg` | `varchar(50)` | UNIQUE | Registro sanitario SENASAG |
| `geographic_region` | `varchar(100)` | NOT NULL | Región/Departamento |
| `country_code` | `char(2)` | NOT NULL default `'BO'` | ISO 3166-1 |
| `address` | `text` | | |
| `contact_email` | `varchar(255)` | NOT NULL | |
| `contact_phone` | `varchar(20)` | | |
| `logo_url` | `varchar(500)` | | Supabase Storage URL |
| `stellar_public_key` | `varchar(60)` | UNIQUE | Wallet Stellar de la bodega (Dynamic) |
| `dynamic_vault_id` | `varchar(200)` | UNIQUE | Vault ID en Dynamic |
| `onchain_producer_id` | `varchar(100)` | UNIQUE | ID en C-01 ProducerRegistry |
| `onchain_register_tx_hash` | `varchar(100)` | | TX hash del registro on-chain |
| `is_export_certified` | `boolean` | NOT NULL default `false` | Para exportación (Fase 2) |
| `certification_status` | `winery_status_enum` | NOT NULL default `'PENDING'` | |
| `approved_at` | `timestamptz` | | |
| `approved_by_user_id` | `uuid` | FK → `users.id` | Admin Debro que aprobó |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |
| `updated_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
CREATE TYPE winery_category_enum AS ENUM ('WINERY', 'BREWERY', 'DISTILLERY', 'OTHER');
CREATE TYPE winery_status_enum AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED');
```

---

### `winery_members`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `user_id` | `uuid` | FK → `users.id` NOT NULL | |
| `winery_id` | `uuid` | FK → `wineries.id` NOT NULL | Tenant |
| `member_role` | `winery_member_role_enum` | NOT NULL | |
| `professional_license_number` | `varchar(100)` | | Matrícula profesional |
| `professional_license_pdf_url` | `varchar(500)` | | PDF en Storage |
| `is_active` | `boolean` | NOT NULL default `true` | |
| `joined_at` | `timestamptz` | NOT NULL default `now()` | |

**UNIQUE:** `(user_id, winery_id)`

```sql
CREATE TYPE winery_member_role_enum AS ENUM (
  'OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT'
);
```

---

### `user_wallets`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `user_id` | `uuid` | FK → `users.id` NOT NULL | Propietario (persona o bodega) |
| `winery_id` | `uuid` | FK → `wineries.id` | NULL si es wallet de consumidor personal |
| `stellar_public_address` | `varchar(60)` | UNIQUE NOT NULL | |
| `dynamic_vault_id` | `varchar(200)` | UNIQUE NOT NULL | |
| `wallet_type` | `wallet_type_enum` | NOT NULL default `'CUSTODIAL'` | |
| `wallet_purpose` | `wallet_purpose_enum` | NOT NULL | `CONSUMER_NFT` o `PRODUCER_SIGNING` |
| `is_primary` | `boolean` | NOT NULL default `true` | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
CREATE TYPE wallet_type_enum AS ENUM ('CUSTODIAL', 'SELF_CUSTODY');
CREATE TYPE wallet_purpose_enum AS ENUM (
  'CONSUMER_NFT',       -- Wallet del consumidor para poseer NFTs
  'PRODUCER_SIGNING'    -- Wallet de la bodega para firmar trazabilidad
);
```

---

## Grupo 2 — Trazabilidad ERP

### `terroirs`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `winery_id` | `uuid` | FK → `wineries.id` NOT NULL | Tenant |
| `parcel_name` | `varchar(200)` | NOT NULL | Nombre de la parcela |
| `cadastre_code` | `varchar(50)` | | Código catastral |
| `surface_hectares` | `decimal(10,4)` | NOT NULL | |
| `altitude_masl` | `decimal(8,2)` | NOT NULL | Metros sobre el nivel del mar |
| `latitude` | `decimal(10,8)` | | |
| `longitude` | `decimal(11,8)` | | |
| `geographic_polygon_geojson` | `jsonb` | | Para exportación (Fase 2) |
| `raw_material_type` | `varchar(100)` | NOT NULL | `uva`, `cebada`, `agave`, etc. |
| `variety_name` | `varchar(200)` | NOT NULL | Variedad específica (ej. Moscatel de Alejandría) |
| `soil_type` | `varchar(100)` | | |
| `irrigation_system` | `varchar(100)` | | |
| `is_do_eligible` | `boolean` | NOT NULL default `false` | Elegible para Denominación de Origen |
| `do_type` | `varchar(100)` | | Ej. `D.O. Singani`, `D.O. Tarija` |
| `do_certificate_url` | `varchar(500)` | | PDF del certificado |
| `is_active` | `boolean` | NOT NULL default `true` | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

---

### `harvest_batches`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `winery_id` | `uuid` | FK → `wineries.id` NOT NULL | Tenant |
| `terroir_id` | `uuid` | FK → `terroirs.id` NOT NULL | |
| `harvest_batch_code` | `varchar(50)` | UNIQUE NOT NULL | Código único generado |
| `intake_date` | `date` | NOT NULL | |
| `harvest_year` | `smallint` | NOT NULL | |
| `gross_weight_kg` | `decimal(12,3)` | NOT NULL | |
| `tare_weight_kg` | `decimal(12,3)` | NOT NULL | |
| `net_weight_kg` | `decimal(12,3)` | NOT NULL (GENERATED) | `gross - tare` |
| `brix_degrees` | `decimal(5,2)` | NOT NULL | |
| `initial_ph` | `decimal(4,2)` | NOT NULL | |
| `initial_acidity_gl` | `decimal(6,3)` | NOT NULL | g/l tartárico |
| `temperature_at_intake_c` | `decimal(5,2)` | | |
| `phytosanitary_status` | `phyto_status_enum` | NOT NULL default `'PENDING_INSPECTION'` | |
| `phyto_inspection_pdf_url` | `varchar(500)` | | |
| `certified_by_member_id` | `uuid` | FK → `winery_members.id` | Enólogo/Agrónomo que aprueba |
| `notes` | `text` | | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
CREATE TYPE phyto_status_enum AS ENUM (
  'PENDING_INSPECTION', 'APPROVED', 'REJECTED', 'QUARANTINE'
);
```

---

### `fermentation_tanks`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `winery_id` | `uuid` | FK → `wineries.id` NOT NULL | Tenant |
| `harvest_batch_id` | `uuid` | FK → `harvest_batches.id` NOT NULL | |
| `tank_code` | `varchar(50)` | NOT NULL | |
| `capacity_liters` | `decimal(12,2)` | | |
| `material` | `varchar(50)` | | Acero inox, cemento, madera |
| `volume_filled_liters` | `decimal(12,2)` | | |
| `destination_type` | `destination_type_enum` | | Definido al iniciar (`FERMENTED_WINE`, `SINGANI`, `BEER`, etc.) |
| `status` | `tank_status_enum` | NOT NULL default `'FILLING'` | |
| `start_date` | `timestamptz` | NOT NULL | |
| `end_date` | `timestamptz` | | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
-- destination_type es extensible: cualquier tipo de proceso post-fermentación
CREATE TYPE destination_type_enum AS ENUM (
  'WINE_AGING',    -- Crianza de vino
  'SINGANI_DIST',  -- Destilación de Singani
  'BEER_MATURATION', -- Maduración de cerveza
  'SPIRITS_DIST',  -- Otros destilados
  'OTHER'
);
CREATE TYPE tank_status_enum AS ENUM (
  'FILLING', 'FERMENTING', 'COMPLETED', 'TRANSFERRED', 'CLEANED'
);
```

---

### `fermentation_logs`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `fermentation_tank_id` | `uuid` | FK → `fermentation_tanks.id` NOT NULL | |
| `temperature_celsius` | `decimal(5,2)` | NOT NULL | |
| `specific_gravity` | `decimal(6,4)` | | |
| `ph_value` | `decimal(4,2)` | | |
| `co2_observations` | `varchar(100)` | | Cualitativo |
| `recorded_at` | `timestamptz` | NOT NULL | |
| `recorded_by_user_id` | `uuid` | FK → `users.id` NOT NULL | |
| `notes` | `text` | | |

*Append-only (no se editan registros históricos).*  
**Índices:** `fermentation_tank_id`, `recorded_at`

---

### `enological_treatments`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `fermentation_tank_id` | `uuid` | FK → `fermentation_tanks.id` NOT NULL | |
| `treatment_type` | `treatment_type_enum` | NOT NULL | |
| `additive_name` | `varchar(200)` | NOT NULL | |
| `additive_supplier` | `varchar(200)` | | |
| `dosage_applied_g_per_hl` | `decimal(10,4)` | NOT NULL | |
| `total_applied_g` | `decimal(12,4)` | | |
| `regulatory_auth_code` | `varchar(100)` | NOT NULL | Código SENASAG o regulatorio local |
| `applied_at` | `timestamptz` | NOT NULL | |
| `authorized_by_member_id` | `uuid` | FK → `winery_members.id` NOT NULL | Debe ser enólogo |
| `notes` | `text` | | |

```sql
CREATE TYPE treatment_type_enum AS ENUM (
  'ACIDITY_CORRECTION', 'SO2_ADDITION', 'CLARIFICATION',
  'FILTRATION_AID', 'NUTRIENT_ADDITION', 'ENZYME_ADDITION',
  'OAK_CHIPS', 'FINING_AGENT', 'STABILIZATION', 'OTHER'
);
```

---

### `wine_aging_batches`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `winery_id` | `uuid` | FK → `wineries.id` NOT NULL | Tenant |
| `fermentation_tank_id` | `uuid` | FK → `fermentation_tanks.id` UNIQUE NOT NULL | |
| `container_type` | `varchar(100)` | NOT NULL | Barrica, depósito, ánfora |
| `container_material` | `varchar(100)` | | Roble francés, americano, inox |
| `container_code` | `varchar(100)` | | Identificador físico |
| `barrel_use_cycle` | `integer` | | 1ra, 2da, 3ra vez |
| `volume_liters` | `decimal(12,2)` | | |
| `planned_months` | `integer` | NOT NULL | |
| `lock_until_date` | `date` | NOT NULL | No embotellar antes de esta fecha |
| `aging_status` | `aging_status_enum` | NOT NULL default `'AGING'` | |
| `notes` | `text` | | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
CREATE TYPE aging_status_enum AS ENUM ('AGING', 'READY', 'BOTTLED', 'DISCARDED');
```

---

### `production_batches`
*Tabla genérica para cualquier proceso de transformación post-fermentación (destilación, maduración, etc.).  
Reemplaza/generaliza `singani_distillation_batches` para soportar cualquier bebida.*

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `winery_id` | `uuid` | FK → `wineries.id` NOT NULL | Tenant |
| `fermentation_tank_id` | `uuid` | FK → `fermentation_tanks.id` NOT NULL | |
| `process_type` | `production_process_enum` | NOT NULL | Tipo de proceso |
| `equipment_identifier` | `varchar(100)` | NOT NULL | Alambique, tanque de maduración, etc. |
| `process_start_date` | `date` | NOT NULL | |
| `process_end_date` | `date` | | |
| `input_volume_liters` | `decimal(10,3)` | | Volumen de entrada |
| `output_volume_liters` | `decimal(10,3)` | | Volumen de salida (corazón, etc.) |
| `waste_volume_liters` | `decimal(10,3)` | | Descarte (cabeza + cola para destilados) |
| `initial_alcohol_percentage` | `decimal(5,2)` | | ABV post-proceso |
| `is_do_eligible` | `boolean` | NOT NULL default `false` | Elegible para DO (ej. Singani) |
| `mandatory_rest_until` | `date` | | Reposo obligatorio (destilados) |
| `rest_status` | `rest_status_enum` | NOT NULL default `'NOT_REQUIRED'` | |
| `additional_params` | `jsonb` | | Parámetros específicos del proceso (extensible) |
| `notes` | `text` | | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
CREATE TYPE production_process_enum AS ENUM (
  'SINGANI_DISTILLATION',  -- Destilación tradicional de Singani
  'SPIRITS_DISTILLATION',  -- Otros destilados
  'BEER_MATURATION',       -- Maduración de cerveza
  'SECONDARY_FERMENTATION',-- Segunda fermentación (espumosos)
  'OTHER'
);
CREATE TYPE rest_status_enum AS ENUM (
  'NOT_REQUIRED', 'RESTING', 'READY', 'BOTTLED', 'DISCARDED'
);
```

---

### `bottling_batches`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `winery_id` | `uuid` | FK → `wineries.id` NOT NULL | Tenant |
| `wine_aging_batch_id` | `uuid` | FK → `wine_aging_batches.id` | NULL si es destilado |
| `production_batch_id` | `uuid` | FK → `production_batches.id` | NULL si es vino |
| `product_type` | `beverage_type_enum` | NOT NULL | Tipo de bebida final |
| `international_lot_code` | `varchar(100)` | UNIQUE NOT NULL | Generado automáticamente: `{WINERY_CODE}-{YEAR}-{TYPE}-{SEQ}` |
| `final_alcohol_abv` | `decimal(5,2)` | NOT NULL | ABV final |
| `water_dilution_liters` | `decimal(10,3)` | | Para Singani y otros destilados |
| `total_bottles_packaged` | `integer` | NOT NULL | |
| `packaging_format_cl` | `integer` | NOT NULL | 75, 70, 50, 37 |
| `bottle_type` | `varchar(100)` | | Bordalesa, Borgona, Flute, etc. |
| `label_design_url` | `varchar(500)` | | URL del diseño en Storage |
| `bottling_date` | `date` | NOT NULL | |
| `released_by_member_id` | `uuid` | FK → `winery_members.id` | Enólogo que libera el lote |
| `blockchain_anchor_tx_hash` | `varchar(100)` | | TX hash del anclaje en C-02 |
| `blockchain_data_hash` | `char(64)` | | SHA-256 de los datos anclados |
| `is_anchored_on_chain` | `boolean` | NOT NULL default `false` | Confirmado por indexer |
| `anchored_at` | `timestamptz` | | Cuando fue anclado |
| `qr_batch_url` | `varchar(500)` | | URL pública del QR de trazabilidad del lote (generada al liberar) |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

**CHECK:** `(wine_aging_batch_id IS NOT NULL) OR (production_batch_id IS NOT NULL)`

```sql
-- Extensible: añadir nuevos tipos de bebida sin romper el schema
CREATE TYPE beverage_type_enum AS ENUM (
  'WINE',          -- Vino
  'SINGANI',       -- Singani (D.O. Bolivia)
  'BEER',          -- Cerveza
  'SPIRITS',       -- Destilados generales (whisky, ron, etc.)
  'CIDER',         -- Sidra
  'MEAD',          -- Hidromiel
  'OTHER'
);
```

---

### `batch_lab_analyses`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `bottling_batch_id` | `uuid` | FK → `bottling_batches.id` UNIQUE NOT NULL | Un análisis oficial por lote |
| `certified_laboratory_name` | `varchar(300)` | NOT NULL | |
| `accredited_lab_certification_code` | `varchar(100)` | NOT NULL | |
| `analysis_request_date` | `date` | | |
| `test_performed_at` | `date` | NOT NULL | |
| `actual_alcohol_abv` | `decimal(5,2)` | NOT NULL | Grado alcohólico real |
| `total_alcohol_abv` | `decimal(5,2)` | | Potencial total |
| `total_acidity_tartaric_gl` | `decimal(6,3)` | NOT NULL | |
| `volatile_acidity_acetic_gl` | `decimal(6,3)` | NOT NULL | |
| `free_sulfur_dioxide_mg_l` | `decimal(7,3)` | | SO2 libre |
| `total_sulfur_dioxide_mg_l` | `decimal(7,3)` | | SO2 total |
| `reducing_sugars_gl` | `decimal(7,3)` | | |
| `total_dry_extract_gl` | `decimal(7,3)` | | |
| `sugar_free_dry_extract_gl` | `decimal(7,3)` | | |
| `overpressure_bar` | `decimal(5,2)` | | Para espumosos |
| `methanol_content_mg_l` | `decimal(7,3)` | | Crítico para destilados |
| `copper_content_mg_l` | `decimal(7,3)` | | Para destilados |
| `additional_params` | `jsonb` | | Parámetros adicionales específicos de bebida |
| `laboratory_report_pdf_url` | `varchar(500)` | NOT NULL | |
| `conforms_to_senasag_standards` | `boolean` | NOT NULL default `false` | MVP |
| `conforms_to_eu_standards` | `boolean` | NOT NULL default `false` | Fase 2 |
| `conforms_to_usa_standards` | `boolean` | NOT NULL default `false` | Fase 2 |
| `reviewed_by_member_id` | `uuid` | FK → `winery_members.id` | Enólogo que revisó |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

---

## Grupo 3 — Exportación *(Schema listo, activo en Fase 2)*

### `export_dossiers`

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `uuid` PK | |
| `winery_id` | `uuid` FK | Tenant |
| `destination_country_iso` | `char(2)` | ISO país destino |
| `destination_market` | `export_market_enum` | `EU`, `USA`, `LATAM`, `OTHER` |
| `destination_customs_office` | `varchar(200)` | |
| `importer_company_name` | `varchar(300)` | |
| `importer_tax_id` | `varchar(100)` | |
| `importer_address` | `text` | |
| `dossier_status` | `dossier_status_enum` | `DRAFT`, `SUBMITTED`, `VALIDATED_FOR_CUSTOMS`, `EXPORTED`, `REJECTED` |
| `requested_at` | `timestamptz` | |
| `validated_at` | `timestamptz` | |
| `approved_by_user_id` | `uuid` FK | Admin Debro |
| `notes` | `text` | |

### `export_dossier_items`

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `uuid` PK | |
| `export_dossier_id` | `uuid` FK | |
| `bottling_batch_id` | `uuid` FK | |
| `exported_boxes_count` | `integer` | |
| `units_per_box` | `integer` | |
| `total_net_volume_liters` | `decimal(12,3)` | |
| `total_gross_weight_kg` | `decimal(12,3)` | |
| `hs_code` | `varchar(20)` | Código arancelario |

### `export_documents_generated`

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `uuid` PK | |
| `export_dossier_id` | `uuid` FK | |
| `document_type` | `export_doc_type_enum` | `EU_VI1`, `USA_TTB_COLA`, `SENASAG_EXPORT_CERT`, `CERTIFICATE_OF_ORIGIN`, `PACKING_LIST` |
| `official_document_number` | `varchar(100)` | |
| `document_pdf_url` | `varchar(500)` | |
| `cryptographic_hash_sha256` | `char(64)` | SHA-256 del PDF |
| `blockchain_tx_hash` | `varchar(100)` | Anclaje en C-02 |
| `generated_at` | `timestamptz` | |
| `is_official` | `boolean` | Marcado como final |

---

## Grupo 4 — Tokenización

### `collections`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `winery_id` | `uuid` | FK NOT NULL | Tenant |
| `bottling_batch_id` | `uuid` | FK NOT NULL | Lote físico que respalda |
| `name_es` | `varchar(300)` | NOT NULL | Nombre en español |
| `name_en` | `varchar(300)` | NOT NULL | Nombre en inglés |
| `description_es` | `text` | | |
| `description_en` | `text` | | |
| `story_es` | `text` | | Historia / narrativa de la colección (ES) |
| `story_en` | `text` | | Historia / narrativa de la colección (EN) |
| `tasting_notes_es` | `text` | | Notas de cata (ES) |
| `tasting_notes_en` | `text` | | Notas de cata (EN) |
| `pairing_recommendations_es` | `text` | | Maridaje recomendado (ES) |
| `pairing_recommendations_en` | `text` | | Maridaje recomendado (EN) |
| `cover_image_url` | `varchar(500)` | | Storage URL |
| `distributor_price_usd` | `decimal(12,2)` | NOT NULL | Precio en USD |
| `total_supply` | `integer` | NOT NULL | Botellas a tokenizar |
| `sold_count` | `integer` | NOT NULL default `0` | |
| `presale_enabled` | `boolean` | NOT NULL default `false` | Para Fase 2 |
| `presale_starts_at` | `timestamptz` | | Fase 2 |
| `sale_starts_at` | `timestamptz` | | |
| `sale_ends_at` | `timestamptz` | | |
| `onchain_collection_id` | `varchar(100)` | | ID de colección on-chain |
| `publication_status` | `collection_status_enum` | NOT NULL default `'DRAFT'` | |
| `approved_by_user_id` | `uuid` | FK → `users.id` | Admin Debro |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
CREATE TYPE collection_status_enum AS ENUM (
  'DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'PAUSED', 'SOLD_OUT', 'CLOSED'
);
```

---

### `tokenized_items`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `collection_id` | `uuid` | FK NOT NULL | |
| `winery_id` | `uuid` | FK NOT NULL | Tenant (desnormalizado) |
| `current_owner_user_id` | `uuid` | FK → `users.id` | NULL si no vendido |
| `bottle_serial_number` | `integer` | NOT NULL | Número de serie 1..N en la colección |
| `onchain_token_id` | `varchar(100)` | UNIQUE | ID del NFT en Stellar |
| `token_status` | `token_status_enum` | NOT NULL default `'UNMINTED'` | |
| `metadata_hash` | `char(64)` | | SHA-256 del JSON de metadata |
| `metadata_url` | `varchar(500)` | | URL del JSON en Storage (nft-metadata bucket) |
| `minted_at` | `timestamptz` | | |
| `mint_tx_hash` | `varchar(100)` | | TX hash del mint |
| `burned_at` | `timestamptz` | | |
| `burn_tx_hash` | `varchar(100)` | | TX hash del burn |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

**UNIQUE:** `(collection_id, bottle_serial_number)`

```sql
CREATE TYPE token_status_enum AS ENUM (
  'UNMINTED',  -- En BD, no en blockchain
  'RESERVED',  -- Reservado para compra en proceso (pago pendiente)
  'MINTED',    -- En blockchain, en posesión del dueño
  'BURNED'     -- Quemado tras retiro físico
);
```

---

### `blockchain_events`
*Registro de todos los eventos on-chain indexados desde Stellar.*

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `event_type` | `varchar(100)` | NOT NULL | `ProductMinted`, `ProductBurned`, `BatchAnchored`, etc. |
| `contract_id` | `varchar(60)` | NOT NULL | `C01`, `C02`, `C03`, `C05` |
| `contract_address` | `varchar(60)` | NOT NULL | Dirección Stellar del contrato |
| `tx_hash` | `varchar(100)` | UNIQUE NOT NULL | Hash de la transacción |
| `ledger_sequence` | `bigint` | NOT NULL | Número de ledger |
| `ledger_timestamp` | `timestamptz` | NOT NULL | Timestamp del ledger |
| `payload` | `jsonb` | NOT NULL | Datos completos del evento |
| `related_entity_type` | `varchar(50)` | | `tokenized_item`, `bottling_batch`, etc. |
| `related_entity_id` | `uuid` | | ID de la entidad en Supabase |
| `processed` | `boolean` | NOT NULL default `false` | Si ya fue procesado por el sync |
| `processed_at` | `timestamptz` | | |
| `processing_error` | `text` | | Error si falló el procesamiento |

---

### `product_reviews`
*Calificaciones y notas de cata de consumidores post-retiro. Solo usuarios que quemaron un NFT de esa colección pueden dejar review.*

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `user_id` | `uuid` | FK → `users.id` NOT NULL | |
| `collection_id` | `uuid` | FK → `collections.id` NOT NULL | |
| `tokenized_item_id` | `uuid` | FK → `tokenized_items.id` NOT NULL | Verifica que el usuario realmente retiró una botella |
| `rating_stars` | `smallint` | NOT NULL CHECK (1..5) | Calificación 1 a 5 estrellas |
| `review_comment_es` | `text` | | Comentario en español |
| `review_comment_en` | `text` | | Comentario en inglés |
| `is_visible` | `boolean` | NOT NULL default `true` | Debro puede ocultar reviews inapropiadas |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

**UNIQUE:** `(user_id, tokenized_item_id)` — Un review por botella retirada.

**Regla de negocio:** Solo se puede crear un review si existe un `claim_redemption` donde `claim_redemptions.tokenized_item_id = product_reviews.tokenized_item_id` y el `user_id` coincide. Validado en el Service de NestJS.

---

## Grupo 5 — Órdenes y Pagos

### `orders`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `user_id` | `uuid` | FK → `users.id` NOT NULL | |
| `collection_id` | `uuid` | FK → `collections.id` NOT NULL | |
| `quantity` | `integer` | NOT NULL | |
| `subtotal_usd` | `decimal(12,2)` | NOT NULL | |
| `total_amount_usd` | `decimal(12,2)` | NOT NULL | |
| `payment_method` | `payment_method_enum` | NOT NULL | |
| `payment_status` | `payment_status_enum` | NOT NULL default `'PENDING'` | |
| `payment_gateway_reference` | `varchar(200)` | UNIQUE | charge_id de la plataforma de pagos |
| `payment_gateway_metadata` | `jsonb` | | Datos adicionales del proveedor |
| `is_presale` | `boolean` | NOT NULL default `false` | Fase 2 |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |
| `paid_at` | `timestamptz` | | |

```sql
CREATE TYPE payment_method_enum AS ENUM (
  'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'XLM', 'USDC_STELLAR'
);
CREATE TYPE payment_status_enum AS ENUM (
  'PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REFUNDED', 'CANCELLED'
);
```

---

### `order_items`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `order_id` | `uuid` | FK → `orders.id` NOT NULL | |
| `tokenized_item_id` | `uuid` | FK → `tokenized_items.id` NOT NULL UNIQUE | Un token por order_item |
| `unit_price_usd` | `decimal(12,2)` | NOT NULL | Precio al momento de compra |

---

### `payment_mint_retries`
*Registro de intentos de mint fallidos post-pago para recuperación automática.*

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `order_id` | `uuid` | FK → `orders.id` NOT NULL | |
| `tokenized_item_id` | `uuid` | FK → `tokenized_items.id` NOT NULL | |
| `attempt_number` | `integer` | NOT NULL default `1` | Intento actual (máx 3) |
| `error_message` | `text` | | Error del intento fallido |
| `next_retry_at` | `timestamptz` | | Próximo reintento (backoff) |
| `resolved` | `boolean` | NOT NULL default `false` | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

---

## Grupo 6 — POS y Retiro Físico

### `pickup_locations`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `winery_id` | `uuid` | FK → `wineries.id` | NULL = punto de Debro |
| `location_name_es` | `varchar(200)` | NOT NULL | |
| `location_name_en` | `varchar(200)` | NOT NULL | |
| `address` | `text` | NOT NULL | |
| `city` | `varchar(100)` | NOT NULL | |
| `country_code` | `char(2)` | NOT NULL | |
| `contact_phone` | `varchar(20)` | | |
| `stellar_pos_address` | `varchar(60)` | UNIQUE | Dirección Stellar autorizada en C-05 |
| `pin_hash` | `varchar(200)` | NOT NULL | bcrypt del PIN de acceso |
| `is_active` | `boolean` | NOT NULL default `true` | |
| `operating_hours` | `jsonb` | | `{ "mon": "09:00-18:00", ... }` |
| `registered_in_c05_tx` | `varchar(100)` | | TX hash del registro on-chain |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

---

### `pos_shifts`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `pickup_location_id` | `uuid` | FK NOT NULL | |
| `cashier_user_id` | `uuid` | FK → `users.id` NOT NULL | |
| `shift_opened_at` | `timestamptz` | NOT NULL default `now()` | |
| `shift_closed_at` | `timestamptz` | | |
| `total_claims_processed` | `integer` | NOT NULL default `0` | |
| `total_discrepancies` | `integer` | NOT NULL default `0` | |
| `shift_report_url` | `varchar(500)` | | PDF del reporte en Storage |
| `notes` | `text` | | |

---

### `claim_passes`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `tokenized_item_id` | `uuid` | FK NOT NULL UNIQUE | Un pass activo por token máximo |
| `user_id` | `uuid` | FK → `users.id` NOT NULL | |
| `pickup_location_id` | `uuid` | FK → `pickup_locations.id` | |
| `ephemeral_qr_payload` | `text` | NOT NULL | JSON serializado del QR |
| `onchain_pass_hash` | `char(64)` | UNIQUE NOT NULL | SHA-256 anclado en C-05 |
| `onchain_generate_tx_hash` | `varchar(100)` | | TX hash de generación |
| `expires_at` | `timestamptz` | NOT NULL | |
| `pass_status` | `pass_status_enum` | NOT NULL default `'ACTIVE'` | |
| `created_at` | `timestamptz` | NOT NULL default `now()` | |

```sql
CREATE TYPE pass_status_enum AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED');
```

*UNIQUE partial index:* `CREATE UNIQUE INDEX ON claim_passes(tokenized_item_id) WHERE pass_status = 'ACTIVE';`  
*(Solo puede haber UN pass activo por token a la vez)*

---

### `claim_redemptions`

| Columna | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `claim_pass_id` | `uuid` | FK UNIQUE NOT NULL | Un pass = una redención |
| `tokenized_item_id` | `uuid` | FK NOT NULL | |
| `pos_shift_id` | `uuid` | FK NOT NULL | |
| `pos_operator_user_id` | `uuid` | FK → `users.id` NOT NULL | |
| `burn_tx_hash` | `varchar(100)` | | TX hash del burn en Stellar |
| `redeemed_at` | `timestamptz` | NOT NULL default `now()` | |
| `notes` | `text` | | |

---

## Grupo 7 — Soporte y Auditoría

### `support_tickets`

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK | Quien abrió |
| `winery_id` | `uuid` FK | Bodega relacionada (si aplica) |
| `category` | `ticket_category_enum` | `NFT_CLAIM_ISSUE`, `PAYMENT_ISSUE`, `BATCH_COMPLIANCE`, `ACCOUNT_ACCESS`, `TECHNICAL`, `OTHER` |
| `subject` | `varchar(300)` | |
| `issue_description` | `text` | |
| `ticket_status` | `ticket_status_enum` | `OPEN`, `IN_PROGRESS`, `WAITING_USER`, `RESOLVED`, `CLOSED` |
| `priority` | `ticket_priority_enum` | `LOW`, `NORMAL`, `HIGH`, `URGENT` |
| `assigned_to_user_id` | `uuid` FK | Agente de soporte |
| `resolved_at` | `timestamptz` | |
| `created_at` | `timestamptz` | |

---

### `audit_logs`
*Registro automático de operaciones críticas via DB triggers y middleware.*

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK | Usuario que ejecutó |
| `winery_id` | `uuid` FK | Tenant (si aplica) |
| `action` | `varchar(100)` | Ej. `BATCH_RELEASED`, `NFT_MINTED`, `PRODUCER_REVOKED` |
| `entity_type` | `varchar(50)` | Tipo de entidad afectada |
| `entity_id` | `uuid` | ID de la entidad |
| `old_values` | `jsonb` | Estado antes del cambio |
| `new_values` | `jsonb` | Estado después del cambio |
| `ip_address` | `inet` | |
| `created_at` | `timestamptz` NOT NULL | |

*Append-only. Nunca se editan ni eliminan logs de auditoría.*

---

### `indexer_state`
*Estado del Stellar Event Indexer para recuperación y monitoreo.*

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `serial` PK | |
| `contract_id` | `varchar(60)` NOT NULL | ID lógico del contrato (`C01`, `C02`, etc.) |
| `contract_address` | `varchar(60)` NOT NULL | Dirección Stellar |
| `last_ledger_processed` | `bigint` NOT NULL default `0` | Último ledger indexado |
| `last_tx_hash` | `varchar(100)` | |
| `events_processed` | `bigint` NOT NULL default `0` | |
| `errors_count` | `integer` NOT NULL default `0` | |
| `updated_at` | `timestamptz` NOT NULL default `now()` | |

**UNIQUE:** `contract_id`

---

## Relaciones Principales (Diagrama simplificado)

```
users ──────────────── winery_members ──────── wineries
  │                                                │
  └── user_wallets                         terroirs │ harvest_batches
                                                    │       │
                                           fermentation_tanks
                                                    │
                               wine_aging_batches ──┤── production_batches
                                                    │
                                          bottling_batches ── batch_lab_analyses
                                                    │
                                              collections
                                                    │
                                          tokenized_items ── orders ── order_items
                                                    │
                                            claim_passes
                                                    │
                                         claim_redemptions ── pos_shifts ── pickup_locations
```
