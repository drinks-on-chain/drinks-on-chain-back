# Base de Datos — Registro Incremental de Tablas

> Este documento registra de manera acumulativa las tablas, atributos, tipos, relaciones e índices que se van implementando **fase por fase** en `prisma/schema.prisma`.
>
> 💡 *Para consultar el catálogo arquitectónico de referencia de las 28 entidades planificadas, ver [`docs/bd/entidades.md`](file:///c:/Proyectos/stellar/drinks-on-chain/docs/bd/entidades.md).*

---

## 📊 Estado Actual de la Base de Datos

| Fase | Tablas Implementadas | Estado de Migración |
|---|---|---|
| **Fase 1: Scaffolding & Infraestructura** | `system_health` (infraestructura/ping) | ✅ Migrada y verificada en PostgreSQL |
| **Fase 2: Smart Contracts & Stellar Relayer** | *(Sin tablas de BD - contratos Soroban)* | Desacoplada / Lista para conexión posterior |
| **Fase 3: Identidad, Auth & Wineries** | `users`, `wineries`, `winery_members`, `user_wallets` | ✅ Migrada y sincronizada en PostgreSQL |
| **Fase 4: ERP de Trazabilidad B2B** | `terroirs`, `harvest_batches`, `fermentation_tanks`, `fermentation_logs`, `enological_treatments`, `wine_aging_batches`, `production_batches`, `bottling_batches`, `batch_lab_analyses` | ✅ Migrada y sincronizada en PostgreSQL |
| **Fase 5: Tokenización & Colecciones** | `collections`, `tokenized_items` | Planificada |
| **Fase 6: Pagos & Órdenes** | `orders`, `order_items`, `payment_mint_retries` | Planificada |
| **Fase 7: Claims & POS** | `pickup_locations`, `pos_shifts`, `claim_passes`, `claim_redemptions` | Planificada |
| **Fase 8: Indexer & Background Tasks** | `blockchain_events`, `indexer_state` | Planificada |
| **Fase 9: Visor Público, Reviews & Auditoría** | `product_reviews`, `support_tickets`, `audit_logs`, `enum_labels` | Planificada |

---

## 🧱 Tablas Implementadas por Fase

### Fase 1: Scaffolding e Infraestructura

#### `system_health`
*Tabla de auditoría base del sistema y verificación de conectividad.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador único del chequeo |
| `checked_at` | `DateTime` | default `now()` | Timestamp del chequeo |
| `status` | `String` | default `'OK'` | Estado de salud del sistema |

---

### Fase 3: Identidad, Autenticación JWT, Wallets y Multi-Tenancy

#### `users`
*Almacena la identidad universal, credenciales hasheadas y roles globales de los usuarios.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador único del usuario |
| `email` | `String (VarChar 255)` | UNIQUE, NOT NULL | Correo electrónico principal |
| `phone_number` | `String? (VarChar 20)` | UNIQUE, Nullable | Teléfono de contacto o verificación MFA |
| `password_hash` | `String (VarChar 255)` | NOT NULL | Contraseña cifrada con bcrypt (cost factor 12) |
| `full_name` | `String (VarChar 200)` | NOT NULL | Nombre y apellidos o razón social |
| `dynamic_user_id` | `String? (VarChar 200)` | UNIQUE, Nullable | Identificador en Dynamic API |
| `preferred_locale` | `String (Char 2)` | default `'es'` | Idioma preferido (`es` / `en`) |
| `is_active` | `Boolean` | default `true` | Estado activo de la cuenta |
| `last_login_at` | `DateTime? (Timestamptz)` | Nullable | Última fecha de login exitoso |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de creación del registro |
| `updated_at` | `DateTime (Timestamptz)` | default `now()`, updatedAt | Fecha de última actualización |

---

#### `wineries`
*Entidad raíz de multi-tenancy (`wineryId`). Representa a las bodegas y destilerías registradas.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador único de la bodega |
| `legal_name` | `String (VarChar 300)` | NOT NULL | Razón social legal de la empresa |
| `commercial_name` | `String (VarChar 300)` | NOT NULL | Marca comercial de la bodega |
| `beverage_category` | `WineryCategoryEnum` | NOT NULL | `WINERY`, `BREWERY`, `DISTILLERY`, `OTHER` |
| `tax_id_nit` | `String (VarChar 20)` | UNIQUE, NOT NULL | NIT boliviano |
| `senasag_sanitary_reg` | `String? (VarChar 50)` | UNIQUE, Nullable | Registro Sanitario SENASAG |
| `geographic_region` | `String (VarChar 100)` | NOT NULL | Región/Valle geográfico |
| `country_code` | `String (Char 2)` | default `'BO'` | Código de país ISO 3166-1 alfa-2 |
| `address` | `String? (Text)` | Nullable | Dirección física de las instalaciones |
| `contact_email` | `String (VarChar 255)` | NOT NULL | Correo de contacto institucional |
| `contact_phone` | `String? (VarChar 20)` | Nullable | Teléfono de contacto institucional |
| `logo_url` | `String? (VarChar 500)` | Nullable | URL de la imagen del logotipo |
| `stellar_public_key` | `String? (VarChar 60)` | UNIQUE, Nullable | Clave pública Stellar de la bodega |
| `dynamic_vault_id` | `String? (VarChar 200)` | UNIQUE, Nullable | ID de la bóveda custodial |
| `onchain_producer_id` | `String? (VarChar 100)` | UNIQUE, Nullable | ID en el Smart Contract C-01 ProducerRegistry |
| `onchain_register_tx_hash`| `String? (VarChar 100)` | Nullable | Hash de transacción de registro en Stellar |
| `is_export_certified` | `Boolean` | default `false` | Indica si cuenta con certificación de exportación |
| `certification_status`| `WineryStatusEnum` | default `PENDING` | `PENDING`, `ACTIVE`, `SUSPENDED`, `REVOKED` |
| `approved_at` | `DateTime? (Timestamptz)` | Nullable | Fecha en la que fue aprobada por Platform Admin |
| `approved_by_user_id` | `String? (UUID)` | FK → `users.id`, Nullable | Usuario Platform Admin que aprobó |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de creación del registro |
| `updated_at` | `DateTime (Timestamptz)` | default `now()`, updatedAt | Fecha de última modificación |

---

#### `winery_members`
*Tabla asociativa para la gestión de personal operativo y roles específicos en cada bodega.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador de la membresía |
| `user_id` | `String (UUID)` | FK → `users.id`, NOT NULL | Usuario vinculado |
| `winery_id` | `String (UUID)` | FK → `wineries.id`, NOT NULL | Bodega (Tenant) |
| `member_role` | `WineryMemberRoleEnum` | NOT NULL | `OWNER`, `ENOLOGIST`, `AGRONOMIST`, `OPERATOR`, `ACCOUNTANT` |
| `professional_license_number` | `String? (VarChar 100)` | Nullable | Matrícula profesional (enólogos/agrónomos) |
| `professional_license_pdf_url`| `String? (VarChar 500)` | Nullable | Documento de respaldo en storage |
| `is_active` | `Boolean` | default `true` | Estado activo del miembro en la bodega |
| `joined_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de incorporación |

**Restricción de unicidad:** `@@unique([userId, wineryId])`

---

#### `user_wallets`
*Almacena las billeteras de custodia Web3 y claves públicas de Stellar de usuarios y bodegas.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador del registro de wallet |
| `user_id` | `String (UUID)` | FK → `users.id`, NOT NULL | Usuario propietario |
| `winery_id` | `String? (UUID)` | FK → `wineries.id`, Nullable | Bodega asociada (si es wallet institucional) |
| `stellar_public_address` | `String (VarChar 60)` | UNIQUE, NOT NULL | Clave pública de Stellar (`G...` de 56 caracteres) |
| `dynamic_vault_id` | `String (VarChar 200)` | UNIQUE, NOT NULL | Identificador de bóveda en Dynamic API |
| `wallet_type` | `WalletTypeEnum` | default `CUSTODIAL` | `CUSTODIAL`, `SELF_CUSTODY` |
| `wallet_purpose` | `WalletPurposeEnum` | NOT NULL | `CONSUMER_NFT`, `PRODUCER_SIGNING` |
| `is_primary` | `Boolean` | default `true` | Indica si es la wallet principal de la cuenta |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de creación del registro |

---

### Fase 4: ERP de Trazabilidad Agroalimentaria & Strategy Pattern

#### `terroirs`
*Parcelas agrícolas, viñedos o campos de cebada/lúpulo georreferenciados.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador único de la parcela |
| `winery_id` | `String (UUID)` | FK → `wineries.id`, NOT NULL | Bodega propietaria (Tenant) |
| `parcel_name` | `String (VarChar 200)` | NOT NULL | Nombre de la parcela/cuartel |
| `cadastre_code` | `String? (VarChar 100)` | Nullable | Código catastral oficial |
| `surface_hectares` | `Decimal(8, 4)?` | Nullable | Superficie cultivada en hectáreas |
| `altitude_masl` | `Decimal(7, 2)` | NOT NULL | Altitud sobre el nivel del mar (msnm) |
| `latitude` | `Decimal(10, 7)?` | Nullable | Latitud GPS central |
| `longitude` | `Decimal(10, 7)?` | Nullable | Longitud GPS central |
| `polygon_geojson` | `Json?` | Nullable | Polígono geográfico GeoJSON |
| `soil_type` | `String? (VarChar 100)` | Nullable | Composición del suelo |
| `sun_exposure` | `String? (VarChar 100)` | Nullable | Orientación / Exposición solar |
| `raw_material_type` | `String (VarChar 50)` | default `'uva'` | Materia prima (`uva`, `cebada`, etc.) |
| `variety_name` | `String (VarChar 100)` | NOT NULL | Varietal (ej. Moscatel de Alejandría) |
| `rootstock` | `String? (VarChar 100)` | Nullable | Portainjerto / Pie americano |
| `planting_year` | `Int?` | Nullable | Año de plantación del viñedo |
| `is_do_eligible` | `Boolean` | default `false` | Elegibilidad para Denominación de Origen |
| `do_type` | `String? (VarChar 100)` | Nullable | D.O. específica (`D.O. Singani`, etc.) |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de registro |

---

#### `harvest_batches`
*Lotes de cosecha y pesaje en báscula de bodega con control fitosanitario.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador único del lote de vendimia |
| `winery_id` | `String (UUID)` | FK → `wineries.id`, NOT NULL | Bodega (Tenant) |
| `terroir_id` | `String (UUID)` | FK → `terroirs.id`, NOT NULL | Parcela de procedencia |
| `harvest_batch_code` | `String (VarChar 100)` | UNIQUE, NOT NULL | Código único del lote de vendimia |
| `intake_date` | `DateTime (Timestamptz)` | NOT NULL | Fecha y hora de recepción en bodega |
| `harvest_year` | `Int` | NOT NULL | Año de la vendimia |
| `gross_weight_kg` | `Decimal(10, 2)` | NOT NULL | Peso bruto en báscula (kg) |
| `tare_weight_kg` | `Decimal(10, 2)` | NOT NULL | Peso tara de transporte (kg) |
| `net_weight_kg` | `Decimal(10, 2)` | NOT NULL | Peso neto calculado (`gross - tare`) |
| `brix_degrees` | `Decimal(5, 2)` | NOT NULL | Grados Brix de madurez refractométrica |
| `initial_ph` | `Decimal(4, 2)` | NOT NULL | pH inicial del mosto |
| `initial_acidity_gl` | `Decimal(5, 2)` | NOT NULL | Acidez total inicial (g/L ácido tartárico) |
| `temperature_at_intake_c` | `Decimal(4, 2)?` | Nullable | Temperatura de descarga (°C) |
| `phytosanitary_status` | `PhytoStatusEnum` | default `PENDING_INSPECTION` | `PENDING_INSPECTION`, `APPROVED`, `REJECTED`, `QUARANTINE` |
| `phyto_inspection_pdf_url` | `String? (VarChar 500)` | Nullable | Acta de inspección fitosanitaria |
| `certified_by_member_id` | `String? (UUID)` | FK → `winery_members.id`, Nullable | Enólogo/Agrónomo certificador |
| `notes` | `String? (Text)` | Nullable | Observaciones de recepción |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de registro |

---

#### `fermentation_tanks`
*Tanques, cubas y silos donde se realiza la fermentación alcohólica/maloláctica.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador único de la cuba |
| `winery_id` | `String (UUID)` | FK → `wineries.id`, NOT NULL | Bodega (Tenant) |
| `harvest_batch_id` | `String (UUID)` | FK → `harvest_batches.id`, NOT NULL | Lote de vendimia alimentado |
| `tank_code` | `String (VarChar 50)` | NOT NULL | Identificador físico de la cuba |
| `capacity_liters` | `Decimal(10, 2)?` | Nullable | Capacidad total nominal (L) |
| `material` | `String? (VarChar 100)` | Nullable | Material (Inox AISI 316, Concreto, etc.) |
| `volume_filled_liters` | `Decimal(10, 2)?` | Nullable | Volumen de mosto cargado (L) |
| `destination_type` | `DestinationTypeEnum` | NOT NULL | `WINE_AGING`, `SINGANI_DIST`, `BEER_CONDITIONING`, `DIRECT_BOTTLING`, `OTHER` |
| `status` | `TankStatusEnum` | default `FILLING` | `FILLING`, `FERMENTING`, `RESTING`, `DRAINED`, `CLEANING` |
| `start_date` | `DateTime (Timestamptz)` | NOT NULL | Fecha de inicio de fermentación |
| `end_date` | `DateTime? (Timestamptz)` | Nullable | Fecha de finalización |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de registro |

---

#### `fermentation_logs`
*Lecturas térmicas y fisicoquímicas append-only del proceso fermentativo.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador del log |
| `fermentation_tank_id` | `String (UUID)` | FK → `fermentation_tanks.id`, NOT NULL | Cuba monitoreada |
| `temperature_celsius` | `Decimal(4, 2)` | NOT NULL | Temperatura registrada (°C) |
| `specific_gravity` | `Decimal(5, 4)?` | Nullable | Densidad relativa (Babo/Oechsle) |
| `ph_value` | `Decimal(4, 2)?` | Nullable | pH actual del líquido |
| `co2_observations` | `String? (Text)` | Nullable | Observaciones de cinética fermentativa |
| `recorded_at` | `DateTime (Timestamptz)` | NOT NULL | Fecha y hora de la lectura |
| `recorded_by_user_id` | `String? (UUID)` | FK → `users.id`, Nullable | Operador que tomó la muestra |
| `notes` | `String? (Text)` | Nullable | Notas de bodega |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de guardado |

---

#### `enological_treatments`
*Adiciones, correcciones y tratamientos enológicos autorizados (SO2, levaduras, clarificantes).*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador del tratamiento |
| `fermentation_tank_id` | `String (UUID)` | FK → `fermentation_tanks.id`, NOT NULL | Cuba tratada |
| `treatment_type` | `TreatmentTypeEnum` | NOT NULL | `SO2_ADDITION`, `YEAST_INOCULATION`, `NUTRIENT_ADDITION`, `ACIDIFICATION`, `DEACIDIFICATION`, `CLARIFICATION`, `FILTRATION`, `ENZYME_ADDITION`, `OENOLOGICAL_TANNINS`, `OTHER` |
| `additive_name` | `String (VarChar 200)` | NOT NULL | Nombre comercial/químico del aditivo |
| `additive_supplier` | `String? (VarChar 200)` | Nullable | Proveedor certificado |
| `dosage_applied_g_per_hl` | `Decimal(8, 3)` | NOT NULL | Dosis aplicada en g/hL |
| `total_applied_g` | `Decimal(10, 3)?` | Nullable | Masa total agregada en gramos |
| `regulatory_auth_code` | `String? (VarChar 100)` | Nullable | Código de autorización SENASAG |
| `applied_at` | `DateTime (Timestamptz)` | NOT NULL | Fecha y hora de aplicación |
| `authorized_by_member_id` | `String (UUID)` | FK → `winery_members.id`, NOT NULL | Enólogo responsable |
| `notes` | `String? (Text)` | Nullable | Justificación enológica |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de registro |

---

#### `wine_aging_batches`
*Crianza en barricas o tinajas con bloqueo de fecha para vinos de guarda.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador del lote de crianza |
| `winery_id` | `String (UUID)` | FK → `wineries.id`, NOT NULL | Bodega (Tenant) |
| `fermentation_tank_id` | `String (UUID)` | FK → `fermentation_tanks.id`, UNIQUE, NOT NULL | Cuba de origen |
| `container_type` | `String (VarChar 50)` | NOT NULL | Tipo (`Barrica`, `Tonel`, etc.) |
| `container_material` | `String? (VarChar 100)` | Nullable | Madera (`Roble Francés`, etc.) |
| `container_code` | `String? (VarChar 50)` | Nullable | Código físico de la barrica |
| `barrel_use_cycle` | `Int?` | Nullable | Ciclo de uso (1 = primer uso) |
| `volume_liters` | `Decimal(10, 2)?` | Nullable | Volumen en litros |
| `planned_months` | `Int` | NOT NULL | Meses proyectados de guarda |
| `lock_until_date` | `DateTime (Timestamptz)` | NOT NULL | Fecha límite de bloqueo de crianza |
| `aging_status` | `AgingStatusEnum` | default `AGING` | `AGING`, `COMPLETED`, `INTERRUPTED` |
| `notes` | `String? (Text)` | Nullable | Notas de cava |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de inicio |

---

#### `production_batches`
*Lotes de destilación de Singani, cocción cervecera o maceración con control de reposo.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador del lote de producción |
| `winery_id` | `String (UUID)` | FK → `wineries.id`, NOT NULL | Bodega (Tenant) |
| `fermentation_tank_id` | `String (UUID)` | FK → `fermentation_tanks.id`, UNIQUE, NOT NULL | Cuba alimentada |
| `process_type` | `ProductionProcessEnum` | NOT NULL | `SINGANI_DISTILLATION`, `BEER_BREWING`, `LIQUEUR_MACERATION`, `WINE_BLENDING`, `OTHER` |
| `equipment_identifier` | `String (VarChar 100)` | NOT NULL | Alambique, caldero o macerador |
| `process_start_date` | `DateTime (Timestamptz)` | NOT NULL | Fecha de inicio del proceso |
| `process_end_date` | `DateTime? (Timestamptz)` | Nullable | Fecha de corte / conclusión |
| `input_volume_liters` | `Decimal(10, 2)?` | Nullable | Volumen de vino base cargado (L) |
| `output_volume_liters` | `Decimal(10, 2)?` | Nullable | Volumen obtenido (corazón) (L) |
| `waste_volume_liters` | `Decimal(10, 2)?` | Nullable | Volumen de descarte (cabezas/colas) |
| `initial_alcohol_percentage` | `Decimal(5, 2)?` | Nullable | Graduación alcohólica inicial (% ABV) |
| `is_do_eligible` | `Boolean` | default `true` | Cumplimiento normativo D.O. |
| `mandatory_rest_until` | `DateTime? (Timestamptz)` | Nullable | Fecha de cumplimiento de 180 días |
| `rest_status` | `RestStatusEnum` | default `NOT_REQUIRED` | `NOT_REQUIRED`, `RESTING`, `READY` |
| `additional_params` | `Json?` | Nullable | Metadatos de destilación / cocción |
| `notes` | `String? (Text)` | Nullable | Observaciones operativas |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de registro |

---

#### `bottling_batches`
*Lotes de fraccionamiento y envasado final con código internacional y hash criptográfico.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador único del lote de embotellado |
| `winery_id` | `String (UUID)` | FK → `wineries.id`, NOT NULL | Bodega (Tenant) |
| `wine_aging_batch_id` | `String? (UUID)` | FK → `wine_aging_batches.id`, Nullable | Lote de crianza de origen |
| `production_batch_id` | `String? (UUID)` | FK → `production_batches.id`, Nullable | Lote de destilación/producción |
| `product_type` | `BeverageTypeEnum` | NOT NULL | `WINE`, `SINGANI`, `BEER`, `OTHER` |
| `international_lot_code` | `String (VarChar 100)` | UNIQUE, NOT NULL | Código estándar `{WINERY}-{YEAR}-{TYPE}-{SEQ}` |
| `final_alcohol_abv` | `Decimal(4, 2)` | NOT NULL | Graduación alcohólica final (% ABV) |
| `water_dilution_liters` | `Decimal(10, 2)?` | Nullable | Agua osmotizada agregada en dilución |
| `total_bottles_packaged` | `Int` | NOT NULL | Número total de unidades envasadas |
| `packaging_format_cl` | `Int` | NOT NULL | Capacidad del envase (ej. 75 cL) |
| `bottle_type` | `String? (VarChar 100)` | Nullable | Modelo/color de botella |
| `label_design_url` | `String? (VarChar 500)` | Nullable | Arte o mockup de etiqueta |
| `bottling_date` | `DateTime (Timestamptz)` | NOT NULL | Fecha de embotellado |
| `released_by_member_id` | `String? (UUID)` | FK → `winery_members.id`, Nullable | Enólogo que autorizó la liberación |
| `blockchain_data_hash` | `String (VarChar 64)` | NOT NULL | SHA-256 canónico del lote para Soroban |
| `is_anchored_on_chain` | `Boolean` | default `false` | Anclado en Smart Contract de Trazabilidad |
| `onchain_tx_hash` | `String? (VarChar 100)` | Nullable | Tx hash de anclaje en Stellar |
| `onchain_batch_id` | `String? (VarChar 66)` | Nullable | `BytesN<32>` identificador en Soroban |
| `qr_batch_url` | `String (VarChar 500)` | NOT NULL | URL pública de trazabilidad consumer-facing |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de registro |

---

#### `batch_lab_analyses`
*Certificados físico-químicos oficiales de laboratorio acreditado ISO 17025 / SENASAG.*

| Atributo | Tipo | Constraints | Descripción |
|---|---|---|---|
| `id` | `String (UUID)` | PK, default uuid | Identificador del informe de análisis |
| `bottling_batch_id` | `String (UUID)` | FK → `bottling_batches.id`, UNIQUE, NOT NULL | Lote de embotellado certificado |
| `certified_laboratory_name` | `String (VarChar 200)` | NOT NULL | Laboratorio analítico emisor |
| `accredited_lab_certification_code` | `String? (VarChar 100)` | Nullable | Código de acreditación SENASAG/ISO |
| `analysis_request_date` | `DateTime (Timestamptz)` | NOT NULL | Fecha de toma/solicitud de muestra |
| `test_performed_at` | `DateTime (Timestamptz)` | NOT NULL | Fecha de ejecución del ensayo |
| `actual_alcohol_abv` | `Decimal(4, 2)` | NOT NULL | Grado alcohólico volumétrico (% ABV) |
| `total_acidity_tartaric_gl` | `Decimal(5, 2)?` | Nullable | Acidez total (g/L ácido tartárico) |
| `volatile_acidity_acetic_gl` | `Decimal(5, 2)?` | Nullable | Acidez volátil (g/L ácido acético) |
| `free_so2_mg_l` | `Decimal(6, 2)?` | Nullable | SO2 libre (mg/L) |
| `total_so2_mg_l` | `Decimal(6, 2)?` | Nullable | SO2 total (mg/L) |
| `residual_sugar_gl` | `Decimal(5, 2)?` | Nullable | Azúcares reductores (g/L) |
| `methanol_content_mg_l` | `Decimal(6, 2)?` | Nullable | Metanol (mg/100 mL alcohol anhidro) |
| `copper_content_mg_l` | `Decimal(6, 3)?` | Nullable | Cobre residual (mg/L) |
| `lead_content_mg_l` | `Decimal(6, 3)?` | Nullable | Plomo residual (mg/L) |
| `laboratory_report_pdf_url` | `String (VarChar 500)` | NOT NULL | URL del certificado analítico firmado |
| `conforms_to_senasag_standards` | `Boolean` | default `true` | Dictamen de conformidad bromatológica |
| `certified_by_chemist_name` | `String? (VarChar 200)` | Nullable | Bioquímico/Químico firmante |
| `notes` | `String? (Text)` | Nullable | Observaciones técnicas |
| `created_at` | `DateTime (Timestamptz)` | default `now()` | Fecha de registro |

