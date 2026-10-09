# Registro de cambios

Versiones del backend de Drinks on Chain. El contrato de la API es `openapi.json`; los cambios incompatibles llevan la etiqueta `breaking-change` en su PR (`.github/workflows/openapi.yml`).

## Sin publicar · Ola 3: firmante, transacciones e identidad de la bodega (pasos 3.1 y 3.2)

Primera versión que **habla con la red** (solo testnet y red local; con las variables de la cadena vacías sigue deshabilitada). Detalle en el [README](README.md#firmante-transacciones-e-identidad-de-la-bodega-pasos-31-y-32).

### Añadido

- Firmante del worker que solo acepta intenciones registradas (`chain.tx.requested`), con validación previa (`CHN_INTENT_REJECTED`), firma separada de autorización y sobre, reintentos e idempotencia en la red. Colas `chain` y `chain-poll`; tareas `chain.tx.poll`, `chain.balance.check` y `chain.testnet.fund`.
- Identidad de cada bodega en la red al activarse (cuenta + contrato NFT leído de vuelta) y relleno de las bodegas activas (`chain.identity.backfill`).
- 12 rutas dejan de responder 501: `GET /v1/platform/chain/transactions`, `GET /v1/platform/chain/transactions/{id}`, `POST …/{id}/retry`, `POST …/{id}/abandon`, `GET /v1/platform/chain/accounts`, `GET /v1/platform/wineries/{id}/chain-account`, `POST /v1/platform/wineries/{id}/chain/provision`, `POST …/chain/pause`, `POST …/chain/unpause`, `GET /v1/organizations/current/chain-account`, `GET /.well-known/stellar.toml` y `GET /v1/public/chain/registry`.
- Código de error `CHN_DISABLED` (409): acción sobre la red con la cadena sin configurar.
- Evento del outbox `winery.status_changed` (suspensión, reactivación, revocación) y los de la cadena: `chain.tx.requested`, `chain.tx.confirmed`, `chain.tx.failed`, `chain.alert.raised`, `winery.chain_identity_ready`.
- Variables opcionales: `CHAIN_DEPLOY_MAX_FEE_STROOPS`, `CHAIN_TX_RETRY_DELAYS_MS`, `CHAIN_ENVIRONMENT`, `STELLAR_FRIENDBOT_URL`.
- `deploy/dev/generar-claves-cadena.sh`: genera las claves de la cadena en el servidor sin imprimirlas.

### Cambios

- `@stellar/stellar-sdk` 13.3.0 → **17.2.1** (fijada): la 13 no lee transacciones del protocolo 29.
- `WineryResponseDto.onchainRegisterTxHash`: el hash de `CREATE_WINERY_ACCOUNT` cuando la bodega tiene identidad (antes, siempre `null`).
- `GET /v1/platform/dashboard`: `chain.operationsBalanceXlm` y `chain.anchorBalanceXlm` son la última lectura del worker (antes, cero).
- El `ChainTxRef` de `CHN_TX_NOT_ABANDONABLE` y `CHN_TX_NOT_RETRYABLE` lleva también `meta.status` (abandonar exige `FAILED`; una abandonada no se reintenta).

## 0.3.0-rc.0 · 2026-10-08 · Ola 3: tokenización y cadena (apertura)

Primera versión de la Ola 3 (contrato `o3-tokenizacion`, §12.1): publica el contrato y prepara la base; **todavía no envía nada a la red**. Detalle en el [README](README.md#-cadena-y-tokenización-ola-3--apertura) y en el [roadmap](docs/ROADMAP.md#etapa-3--tokenización-y-cadena-ola-3).

### Añadido

- 54 rutas de la cadena y la tokenización (etiquetas `Chain`, `Tokenization`, `Public`) con su forma definitiva y respuesta `501 NOT_IMPLEMENTED` hasta su paso (3.1–3.6). El OpenAPI pasa de 158 a 212 operaciones. `Idempotency-Key` es **obligatoria** en diez de ellas (sin cabecera: 422 `IDEMPOTENCY_KEY_REQUIRED` con `details[0].field = "Idempotency-Key"`).
- `GET /v1/public/collections/images/{imageId}`: las imágenes públicas de las colecciones las sirve la API (el almacenamiento es privado).
- Campos nuevos en respuestas existentes (aditivos): `tokenization` en `LotSummary` y `Lot`; `tokenization` y `chain` en `GET /v1/platform/dashboard`; `tokenization` en `GET /v1/traceability/dashboard`; capacidades `tokenization`, `chain` y `chain.admin` en `GET /v1/platform/permissions`; seis tipos de evento en la línea de tiempo del lote (`TOKENIZATION_AUTHORIZED`, `NFT_MINTED`, `COLLECTION_PUBLISHED`, `DOSSIER_ANCHORED`, `TOKENS_REDEEMABLE`, `SHORTFALL_DETECTED`).
- `LotDossier.anchor` y `PublicLotPassport.dossier.anchor` tienen forma (`DossierAnchor` / `PublicDossierAnchor`); siguen en `null` hasta el paso 3.5.
- Custodia de claves (`KeyCustody`) con los drivers `LOCAL` y `ENV` (solo testnet y red local), en el worker.
- Variables de la cadena, todas opcionales: ver el README. Sin ellas la cadena queda deshabilitada.

### Cambios de comportamiento (SE-02)

| Qué | Antes | Ahora |
|---|---|---|
| `GET /v1/users/me/wallet` | Dirección simulada (la creaba si faltaba) | 404 `CHN_WALLET_NOT_AVAILABLE` al personal; a un consumidor, su dirección custodial derivada cuando la tenga (Ola 4) |
| `primaryWallet` de `GET /v1/users/me` | Billetera simulada | Siempre `null` |
| `WineryResponseDto.stellarPublicKey` | Dirección simulada | La cuenta real de la bodega o `null` |
| `WineryResponseDto.onchainProducerId`, `onchainRegisterTxHash` | Valores simulados | `null` |
| Registro de un consumidor y aceptación de una invitación | Creaban una billetera simulada | No crean ninguna |
| Eventos `winery.created` y `member.added` | Activaban una bóveda simulada en el worker | Retirados (nadie los emitía desde H1) |
| `STELLAR_NETWORK` | `testnet`, `mainnet`, `futurenet`, `standalone` | `TESTNET`, `PUBLIC`, `LOCAL` (se siguen aceptando `testnet`, `mainnet` y `standalone`) |

Variables que dejan de leerse: `STELLAR_HORIZON_URL`, `STELLAR_SOROBAN_RPC_URL`, `STELLAR_RELAYER_SECRET_KEY`, `STELLAR_INDEXER_POLL_INTERVAL_MS`, `STELLAR_INDEXER_START_LEDGER`.

### Base de datos

Migración *expand* `20261008120000_o3_cadena_expand` (aditiva; no borra ninguna fila ni columna):

- 19 tablas de la cadena y la tokenización con sus invariantes (`CHECK minted ≤ quota`, únicos e índices parciales).
- `wineries`: columnas `chain_account_id`, `legacy_simulated_address` y `legacy_simulated_data`. Los valores de `stellar_public_key`, `dynamic_vault_id`, `onchain_producer_id` y `onchain_register_tx_hash` se copian a las columnas `legacy_*` y se ponen a `NULL`.
- `user_wallets`: columna `status`, `INVALID_SIMULATED` en todas las filas.
- La API anota `CHAIN_SIMULATED_WALLETS_INVALIDATED` en la bitácora, una sola vez, al arrancar tras la migración.

Antes de aplicarla en un entorno con datos: copia de la base (ver [`deploy/README.md`](deploy/README.md#4-migración-de-la-apertura-de-la-ola-3)).

## 0.2.0 · 2026-10-02 · Ola 2: ERP confiable (cierre H2)

Trazabilidad con el lote del servidor, reglas que no se pueden eludir, códigos por botella, expediente con hash y pasaporte público (contrato `o2-erp-confiable`). Esta versión **contrae**: retira lo legado que la apertura mantuvo y endurece el esquema. Detalle en [`docs/arquitectura/trazabilidad.md`](docs/arquitectura/trazabilidad.md#cierre-h2-contracción-v020).

### Cambios incompatibles

Rutas retiradas:

| Ruta | En su lugar |
|---|---|
| `PATCH /v1/harvest-batches/{id}/phyto-status` | `POST /v1/harvest-batches/{id}/phyto-decisions` |
| `POST /v1/bottling` | `POST /v1/lots/{id}/bottling` (y `…/preview`) |
| `POST /v1/lab-analyses` | `POST /v1/lots/{id}/lab-analyses` |
| `GET /v1/traceability/dag/{bottlingBatchId}` | `GET /v1/lots/{id}/graph` |
| `GET /v1/traceability/public/{lotCode}` | `GET /v1/public/passports/{code}` o `GET /v1/public/lots/{lotCode}` |

Campos de entrada retirados (enviarlos responde 422 `VALIDATION_ERROR`, salvo donde se indica) o que pasan a obligatorios:

| Ruta | Cambio |
|---|---|
| `POST /v1/harvest-batches` | Sin `phytosanitaryStatus` (422 `TRC_PHYTO_IN_CREATE`: el dictamen va aparte) ni `brixDegrees`, `initialPh`, `initialAcidityGl` (el análisis va en `maturity` o en `POST …/maturity-analyses`) |
| `POST /v1/terroirs`, `PATCH /v1/terroirs/{id}` | Sin `isDoEligible` (se calcula) |
| `POST /v1/fermentation-tanks` | Sin `harvestBatchId`; `inputs` (≥ 1) y `volumeFilledLiters`, obligatorios |
| `POST /v1/production-batches/distillation` | Sin `processEndDate`, `outputVolumeLiters`, `wasteVolumeLiters`, `additionalParams`, `isDoEligible` (el cierre va en `POST …/{id}/close` con `cuts` tipados); `inputVolumeLiters`, obligatorio |
| `POST /v1/lots/{id}/bottling`, `…/bottling/preview` | Sin `labelDesignUrl` (queda `labelDesignKey`) |
| `POST /v1/lots/{id}/lab-analyses` | Sin `laboratoryReportPdfUrl`; `laboratoryReportKey` (archivo subido con `POST /v1/uploads`), obligatorio |

Comportamiento:

- Crianza y destilación solo desde un tanque `COMPLETED`: en otro estado, 409 `TRC_TANK_NOT_COMPLETED` (se acabó la tolerancia de transición).
- El código de error `TRC_PRODUCT_TYPE_MISMATCH` desaparece con `POST /v1/bottling` (el tipo se deriva del origen).
- La variable `LOT_BACKFILL_ON_BOOT` ya no existe: el relleno de la apertura se retiró.

Los campos de **respuesta** no cambian (`labelDesignUrl`, `laboratoryReportPdfUrl`, `phytoInspectionPdfUrl`, `additionalParams`… siguen saliendo con los datos anteriores).

### Base de datos

- Migración `20261002180000_o2_contraer_h2`: `lot_id NOT NULL` en tanques, crianzas, destilaciones, embotellados y análisis de laboratorio (el pesaje sin lote sigue siendo válido); las 18 claves foráneas de la cadena anterior pasan a `RESTRICT`; índice único parcial de un código activo por serie de botella; índices de las claves consultadas; columna `laboratory_report_sha256`.
- La migración comprueba los datos antes de cambiar nada y **falla con un mensaje claro** si queda un registro sin lote o una serie con dos códigos activos. Comprobación previa y recuperación: [`deploy/README.md`](deploy/README.md#cierre-h2-v020-antes-y-después-del-despliegue).
- Preparado, sin aplicar: rol de la aplicación sin `DELETE` sobre la trazabilidad (`deploy/dev/sql/rol-app-sin-delete.sql`, `MIGRATE_DATABASE_URL`).

### Añadido

- `sha256` en la respuesta de `POST /v1/uploads` y en el informe de un análisis de laboratorio (`report.sha256`).
- `POST /v1/fermentation-tanks/{id}/clean` cierra un tanque `COMPLETED` con remanente cuando ya salió una destilación.
- Al anular una lectura de fermentación, el evento diario de lecturas del lote se recalcula.
- Semilla con los 21 lotes de demostración de `@drinks-on-chain/mocks` 0.5.0, uno o más en cada etapa y uno con el expediente cerrado; de solo inserción (un lote que ya existe no se reescribe).

### De la Ola 2 (ya en `dev` antes de esta versión)

Lote con instantánea de reglas, dictamen separado y sin autoaprobación, D.O. calculada, transiciones del tanque, cierre de la destilación con cortes y balance de masa, embotellado seguro con un código por botella, exportación de códigos (CSV y ZIP), laboratorio con unidades, correcciones compensatorias, expediente con hash canónico y raíz Merkle, vistas del lote (línea de tiempo, balance, grafo, panel, reporte, archivos) y pasaporte público de lotes y botellas. Ver [`docs/ROADMAP.md`](docs/ROADMAP.md), Etapa 2.

## 0.1.1 · 2026-10-01 · Lista de espera

Inscripción pública de consumidores y bodegas, bandeja y exportación en el back office, límites y captcha opcional.

## 0.1.0 · 2026-10-01 · Ola 1: organizaciones y back office (cierre H1)

Organizaciones y membresías con roles, alta de bodegas y equipo, configuración en dos niveles, bitácora y tablero del back office; retirada del rol global y de los campos de compatibilidad.

## 0.0.1 · 2026-09-27 · Ola 0: cimientos (H0)

CI y despliegue de desarrollo, sesiones cortas con renovación rotativa, bitácora encadenada, correo y archivos, outbox y worker, OpenAPI como contrato y semilla de demostración.
