# Registro de cambios

Versiones del backend de Drinks on Chain. El contrato de la API es `openapi.json`; los cambios incompatibles llevan la etiqueta `breaking-change` en su PR (`.github/workflows/openapi.yml`).

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
