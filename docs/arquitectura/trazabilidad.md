# Trazabilidad confiable: el lote del servidor

> Ola 2 · apertura (O2-BE-1; contrato `plan/contratos/o2-erp-confiable.md` §0–§2, §13, §14, §16, §20; docs-back/01 §9.1 EA-01…EA-08 y SE-07; docs-back/08 §5). Esta página describe lo que ya está en `dev`: el modelo del lote, la instantánea de reglas, la migración de los datos anteriores y los cierres de seguridad. Lo que el contrato publica pero aún no tiene lógica responde **501 `NOT_IMPLEMENTED`** (ver [Rutas](#rutas)).

## Modelo

Antes de la Ola 2 la trazabilidad era una cadena sin raíz (`Terroir → HarvestBatch → FermentationTank → WineAgingBatch | ProductionBatch → BottlingBatch → BatchLabAnalysis`) y el ERP derivaba un "lote" en el cliente (`LotView`). Ahora el **lote es una entidad del servidor** que agrupa la cadena:

```mermaid
flowchart LR
  L[("lots<br/>reference · lotCode · stage<br/>rules (instantánea)")]
  L --- H["harvest_batches*<br/>(lot_id nulo = uva sin lote)"]
  H --- P["phyto_decisions*"]
  H --- M["maturity_analyses*"]
  L --- T["fermentation_tanks*"]
  T --- I["fermentation_tank_inputs*<br/>(kg de cada pesaje)"]
  L --- A["wine_aging_batches*"]
  L --- D["production_batches*"]
  L --- B["bottling_batches (0..1, único)"]
  B --- U["bottle_units*<br/>(un código por botella)"]
  L --- Q["batch_lab_analyses*<br/>(el vigente decide)"]
  L --- E["lot_events* (línea de tiempo)"]
  L --- C["lot_compliance_issues*"]
  L --- S["lot_sequences<br/>(por bodega, año y ámbito)"]
```

| Tabla | Qué guarda |
|---|---|
| `lots` | Referencia interna `{lotPrefix}-L{año}-{NNN}` (desde la creación), código de lote de la etiqueta (`lotCode`, al embotellar), nombre, `productType` (`WINE`/`SINGANI`, nulo hasta decidirse), `stage` calculada, añada, estimación de botellas, formato y grado previstos, fecha objetivo, parcelas previstas, **`rules`** (instantánea) con `rules_origin` (`LOT_CREATION`/`MIGRATION`), descarte con motivo y autor |
| `lot_events` | Línea de tiempo (§11.1): un evento por escritura, en la misma transacción, con `seq` consecutivo por lote (la fila del lote está bloqueada), `occurred_at` (la fecha del hecho) y `recorded_at`, etapa tras el evento, actor (membresía), resumen, datos con unidad, recurso y visibilidad (`PUBLIC`/`INTERNAL`). Las lecturas de fermentación se agrupan en un evento por tanque y día |
| `lot_sequences` | Secuencias por bodega, año y ámbito (`HARVEST`, `LOT_CODE`, `LOT_REFERENCE`) |
| `phyto_decisions` | Dictámenes fitosanitarios (solo inserción; el estado del pesaje es el del último) con autor, informe (`key`) y origen (`ERP`/`MIGRATION`) |
| `maturity_analyses` | Análisis de madurez (Brix, pH, acidez) separados del pesaje; el último por fecha de medición es el vigente y se refleja en el pesaje |
| `fermentation_tank_inputs` | Kilos de cada pesaje que entran a un tanque (`availableKg` = neto − entradas) |
| `bottle_units` | Código de botella (8 caracteres Crockford: 7 aleatorios + control Luhn mod 32), serie, estado (`ACTIVE`/`VOIDED`), sal de la hoja Merkle |
| `lot_compliance_issues` | Incidencias de cumplimiento (`MIGRATION`, `CORRECTION`, `RULES_REEVALUATION`) con `details` ampliados; una abierta bloquea el embotellado |
| `bottle_code_exports`, `trace_corrections`, `lot_attachments`, `lot_dossiers` | Creadas en la apertura para los pasos 2.6–2.9 (sin lógica todavía) |
| `lot_backfill_pending` | Cola del relleno de la migración (ver [Migración](#migración-de-los-datos-anteriores-26)) |

Columnas nuevas (todas nulas o con valor por defecto) en la cadena actual: `lot_id` en pesajes, tanques, crianzas, destilaciones, embotellados (única: **un embotellado por lote**) y análisis; `created_by_membership_id` (autoría real, `TraceActor`); `terroir_snapshot` del pesaje; `final_volume_liters` del tanque; `start_date`, `container_count` y descarte de la crianza; cortes (`heads/heart/tails/vinasse_liters`, `heart_abv_percent`) y descarte de la destilación; `available_liters`, remanente y `label_design_key` del embotellado; `methanol_mg_100ml_aa`, `conformity`, `conformity_status`, `superseded_at` y `laboratory_report_key` del análisis. Brix, pH y acidez del pesaje pasan a ser **nulos** sin análisis.

Dos restricciones únicas se relajan: el código de vendimia es único **por bodega** (su secuencia es por bodega) y un embotellado admite **varios análisis** (reanálisis: el nuevo sustituye al anterior, sin 409).

Los actores se guardan por su membresía (`*_membership_id`, sin clave foránea, como en la bitácora) y se resuelven a `TraceActor { membershipId, userId, fullName, role }`; `null` = sistema o no registrado (datos anteriores). Las claves foráneas nuevas son `Restrict`; las antiguas `Cascade` pasan a `Restrict` en el cierre de la ola (H2), junto con `lot_id NOT NULL` (salvo en pesajes).

El código vive en `src/modules/lots/`: `domain/` (reglas puras y probadas: D.O., laboratorio, candados, balance, códigos de botella, etapa, fechas en La Paz), `lot-records.ts` (crear y bloquear lotes, recalcular la etapa), `bottling-engine.ts` (reglas del embotellado), `lot-backfill.ts` (relleno), `chain.ts` (destino, D.O. y volumen de la cadena) y `contract/` (rutas del contrato con 501).

## Instantánea de reglas (CFG-06)

Al crear el lote se guarda `SettingsService.snapshot(wineryId)` (parámetros `appliesAt: 'LOT'`, **leídos de la base**, con la excepción legal de A-31) como `LotRules`:

```ts
{ takenAt, origin: 'LOT_CREATION' | 'MIGRATION',
  singani: { minAltitudeMasl, requiredVarieties, minRestDays },
  wine: { minAgingMonths }, phytosanitary: { requireApproved },
  bottling: { maxLossPercent }, lab: { limits },
  legalExceptions, sources, values }
```

Todas las validaciones del lote usan **esa** instantánea aunque la configuración cambie después: un cambio en el back office solo afecta a los lotes creados después (probado en e2e). La instantánea no se edita nunca. La aptitud D.O. de las **parcelas** (que no pertenecen a un lote) usa los valores **efectivos** de la bodega (`rulesSource: EFFECTIVE_SETTINGS`).

## Etapa del lote (§2.2)

La calcula el servidor a partir de los registros (`deriveLotStage`); ninguna ruta la fija salvo el descarte: `ORIGIN` (sin pesajes) → `HARVEST` → `FERMENTING` (algún tanque) → `AGING` (crianza) o `DISTILLING`/`RESTING` (destilaciones abiertas/cerradas) → `BOTTLED` → `CERTIFIED` (expediente cerrado, paso 2.8) → `ANCHORED` (Ola 3). `REJECTED` (todos los pesajes rechazados y ninguno en un tanque) y `DISCARDED` (con motivo: fuentes abiertas a `DISCARDED` y códigos de botella anulados). `REJECTED`, `DISCARDED` y `CERTIFIED` son terminales: toda escritura → 409 `TRC_LOT_TERMINAL`.

El lote nace en origen (`POST /v1/lots`), desde el pesaje (`newLot`) o desde el tanque (`newLot`). Un pesaje puede registrarse **sin lote** (uva recibida, `GET /v1/harvest-batches?lotId=none`); al llenar un tanque con uva sin lote y sin `lotId`/`newLot`, el servidor crea el lote del tanque (compatibilidad con el ERP actual, que no conoce los lotes).

## Reglas que ya no se pueden eludir

Todas se evalúan en el servidor con la instantánea del lote y el **reloj de la base de datos** (`now()` y el día en America/La_Paz), dentro de una transacción que bloquea la fila del lote (`SELECT … FOR UPDATE`).

| Hallazgo | Antes | Ahora |
|---|---|---|
| **EA-04** dictamen | `phytosanitaryStatus` en el alta del pesaje (autoaprobación); se fermentaba uva rechazada | El alta solo admite `PENDING_INSPECTION` (otro → 422 `TRC_PHYTO_IN_CREATE`). El dictamen va aparte (`POST …/phyto-decisions`, solo inserción; `APPROVED`/`REJECTED` finales; `REJECTED`/`QUARANTINE` con motivo; nada cambia con la uva en un tanque → 409 `TRC_PHYTO_DECISION_FINAL`). Un tanque exige `APPROVED` (o `PENDING` si la instantánea no lo exige; nunca `REJECTED`/`QUARANTINE`) → 422 `TRC_PHYTO_NOT_APPROVED` con un detalle por pesaje. `PATCH …/phyto-status` es un alias que ya no pisa las notas |
| **EA-01** tipo del embotellado | La estrategia se elegía con el `productType` que enviaba el cliente (`WINE` sobre una destilación no miraba el reposo) | El tipo se deriva del origen (crianza → `WINE`, destilación → `SINGANI`); uno distinto → 422 `TRC_PRODUCT_TYPE_MISMATCH`. Candados: `unlockDate ≤ hoy` (reloj de la base) **y** `≤ bottlingDate` → si no, 422 `TRC_LOCK_NOT_RELEASED` con `rule`, `unlockDate` y `daysRemaining`. Crianza: inicio + meses de calendario (≥ mínimo de la instantánea); reposo: fin de la destilación + `minRestDays` de la instantánea (no más 180 fijos); con registros anteriores manda la fecha más tardía entre la calculada y la guardada |
| **EA-02** embotellado ilimitado | Sin balance ni estados terminales | Un embotellado por lote (409 `TRC_LOT_ALREADY_BOTTLED` y restricción única `bottling_batches(lot_id)`); todas las fuentes abiertas entran o se descartan antes (`TRC_BOTTLING_SOURCES_PENDING`); balance de volumen `botellas × cL + remanente ≤ disponible + agua` (`TRC_BOTTLING_EXCEEDS_VOLUME` con `maxBottles`) y merma ≤ `maxLossPercent` (`TRC_BOTTLING_LOSS_ABOVE_TOLERANCE`); alcohol puro embotellado ≤ el del corazón con 0,5 % de tolerancia (`TRC_ALCOHOL_BALANCE_EXCEEDED`); vino sin agua (`TRC_DILUTION_NOT_ALLOWED`); incidencias abiertas bloquean (`TRC_COMPLIANCE_ISSUES_OPEN`). Fuentes a `BOTTLED`, tanques a `TRANSFERRED`, lote a `BOTTLED` y un código por botella, en la misma transacción. `blockchainDataHash` ya no se calcula (el hash válido será el del expediente) |
| **EA-03** D.O. | La destilación solo validaba si llegaba `isDoEligible: true`; la parcela declaraba su aptitud | Aptitud calculada: altitud ≥ mínimo y cepa entre las exigidas (sin mayúsculas, tildes ni espacios repetidos; sin sinónimos, P-7). Parcelas: `isDoEligible` calculado con los valores efectivos y `doEvaluation`; el valor enviado se ignora. Lote singani: la parcela del pesaje (`TRC_DO_TERROIR_NOT_ELIGIBLE`), el destino singani de un tanque y cada destilación evalúan **todos** los pesajes del lote con la instantánea (`TRC_DO_NOT_ELIGIBLE`, un detalle por regla con `expected`/`actual`). `ELIGIBLE_BY_EXCEPTION` cuando solo cumple por un valor bajo el mínimo legal autorizado (A-31). Destino coherente con el tipo del lote (`TRC_DESTINATION_MISMATCH`) |
| **EA-07** secuencias | `count + 1` y sufijo por colisión | `lot_sequences` con `INSERT … ON CONFLICT DO UPDATE … RETURNING` (bloqueo de fila); el valor nunca queda por debajo de lo que ya existe en los datos. Código de vendimia `HARV-{año}-{parcela}-{NNN}` por bodega y año; código de lote `{lotPrefix}-{año}-{WINE\|SINGANI}-{NNN}` por bodega y año, común a los productos; referencia `{lotPrefix}-L{año}-{NNN}` |
| **EA-08** laboratorio | `conformsToSenasagStandards` `true` por defecto; metanol en mg/L comparado con un límite en mg/100 mL | Conformidad calculada contra `rules.lab.limits` con unidades explícitas (`units` en la respuesta). Metanol en mg/L de producto → mg/100 mL de alcohol anhidro (`10 × mgL / grado`); si llegan ambos y difieren > 1 % → 422. Parámetros exigidos: singani (metanol, cobre, grado), vino (acidez volátil, grado); falta uno → `INCOMPLETE` (nunca conforme por omisión); unidad desconocida → `UNIT_UNKNOWN`. Aviso si el grado medido difiere > 0,5 % vol del etiquetado |
| **EA-05** (parte) grafo | Métricas fijas (12,80 %, 0,28 g/L), `isCertified: true` fijo, operadores genéricos | Solo datos registrados (métrica vacía si no hay dato), `isCertified` = expediente cerrado, operador desde la membresía o "No registrado" |
| **SE-07** grafo | `GET /traceability/dag/:id` para cualquier sesión; el pasaporte público aceptaba el id | Solo los miembros de la bodega dueña y el personal de plataforma (ADMIN, OPERATIONS, SUPPORT, SUPERADMIN); cualquier otra sesión → 404. El pasaporte legado solo por código de lote |
| **S-25** plataforma | Escribía con `?wineryId=` (contrato O0 §8) | **Solo lee** la trazabilidad (`@PlatformReadOnly()` en parcelas, vendimia, tanques, crianza, destilación, embotellado, laboratorio y lotes): escrituras → 403 `TRC_PLATFORM_READ_ONLY` |

Otras reglas del contrato activas desde la apertura: fechas no futuras (`TRC_DATE_IN_FUTURE`, 5 min de tolerancia en los instantes) ni anteriores a la etapa previa (`TRC_DATE_BEFORE_PREVIOUS_STAGE`) en pesajes, dictámenes, tanques, lecturas, tratamientos, crianzas, destilaciones y laboratorio; entradas de un solo lote por tanque (`TRC_MIXED_LOTS`), kilos ≤ disponibles y llenado ≤ capacidad; código físico del tanque ocupado hasta limpiarlo (409 `TRC_TANK_CODE_IN_USE`); lecturas y tratamientos solo en tanques activos (409 `TRC_TANK_NOT_ACTIVE`); crianza ≥ mínimo de la instantánea (`TRC_AGING_BELOW_MINIMUM`) con `volumeLiters` obligatorio ≤ lo disponible del tanque; destilación con entrada ≤ lo disponible del tanque y cortes ≤ entrada (`TRC_MASS_BALANCE_EXCEEDED`); parcela usada sin `PATCH` de altitud, cepa ni materia prima (409 `TRC_TERROIR_IN_USE`).

### Errores de reglas

Estado del recurso → **409**; regla de negocio incumplida → **422**; plataforma escribiendo → **403**. El código de la respuesta es el de la primera violación y `details` lleva **todas**, con la forma ampliada del contrato O2 §0 (aditiva sobre la de la Ola 0):

```json
{ "field": "bottlingDate", "message": "Reposo mínimo de 180 días: disponible el 2026-10-13 (faltan 16 días)",
  "code": "TRC_LOCK_NOT_RELEASED", "rule": "trazabilidad.singani.reposoMinimoDias",
  "expected": "2026-10-13", "actual": "2026-09-27",
  "meta": { "sourceId": "…", "kind": "REST", "unlockDate": "2026-10-13", "daysRemaining": 16 } }
```

El filtro global conserva `code`, `rule`, `expected`, `actual` y `meta` (`normalizeErrorDetails`); el resto de campos se descarta como antes. La lista completa de códigos está en `src/shared/exceptions/error-codes.ts` y en `docs/rules/03-formato-respuestas.md`.

## Vinificación, crianza y destilación, laboratorio y correcciones (pasos 2.2–2.4 y 2.7)

> O2-BE-1 · bloque A (contrato O2 §3.1, §4, §5, §8, §9 y §15). Estas rutas ya **no** responden 501: `POST /v1/fermentation-tanks/{id}/start|complete|clean`, `POST /v1/wine-aging/{id}/discard`, `POST /v1/production-batches/{id}/close|discard`, `POST/GET /v1/lots/{id}/lab-analyses`, `POST/GET /v1/lots/{id}/corrections` y `POST /v1/terroirs/{id}/corrections`. Cada escritura bloquea la fila del lote y deja su evento en `lot_events` y su entrada de bitácora en la misma transacción.

### Transiciones del tanque (§4.2–§4.3)

El estado del tanque cambia solo con **acciones** (`TankTransitionsService`); una acción desde otro estado → 409 `TRC_TANK_INVALID_TRANSITION` con `meta: { from, to }`.

| Acción | De → a | Reglas | Evento · bitácora |
|---|---|---|---|
| `start` | `FILLING → FERMENTING` | `startedAt` (por defecto, ahora) ni futuro ni anterior al llenado | `FERMENTATION_STARTED` · `TANK_TRANSITION` |
| `complete` | `FERMENTING → COMPLETED` | `finalVolumeLiters ≤ volumeFilledLiters` (`TRC_VOLUME_EXCEEDS_AVAILABLE`); `endDate` ni futura ni anterior al llenado; **bifurcación** | `FERMENTATION_COMPLETED` (y `PRODUCT_DECIDED`) · `TANK_TRANSITION` |
| (automática) | `→ TRANSFERRED` | Al crear la crianza del tanque, al agotarse su volumen con las destilaciones o con `closeTank: true` en la destilación | Historial del tanque |
| `clean` | `TRANSFERRED → CLEANED` | `cleanedAt` ni futuro ni anterior al fin de la fermentación; libera el `tankCode` (S-7) | `TANK_TRANSITION` |

- **Bifurcación (ERP-09)**: `destination` debe coincidir con el tipo del lote (`WINE ↔ WINE_AGING`, `SINGANI ↔ SINGANI_DIST`; si no, 422 `TRC_DESTINATION_MISMATCH`). Si el lote aún no tiene tipo, la primera bifurcación lo fija y todos sus tanques comparten destino. Con destino singani, la D.O. se evalúa sobre **todos** los pesajes del lote con la instantánea (422 `TRC_DO_NOT_ELIGIBLE`): si falla, nada se guarda y el lote sigue sin tipo.
- La respuesta del tanque añade `availableLiters` (el volumen final, o el de llenado, menos lo transferido; 0 con el tanque transferido), `transferLossLiters` (lo que quedó sin transferir: la merma de trasiego) y `transitions` (`{ status, at, by }`, empezando por el llenado). El historial se guarda en `fermentation_tanks.transition_log`.
- Un tanque `TRANSFERRED` o `CLEANED` ya no es origen de una crianza ni de una destilación → 409 `TRC_TANK_NOT_COMPLETED`.
- `clean` no escribe en la línea de tiempo del lote (no es un hecho de su producción y el lote puede estar ya cerrado): queda en el historial del tanque y en la bitácora.

### Crianza, destilación y reposo (§5)

- **Cierre de la destilación** (`POST …/close`): cortes tipados (`cuts.headsLiters`, `heartLiters`, `tailsLiters`, `vinasseLiters?`) y `heartAbvPercent`. **Balance de masa**: cabezas + corazón + colas (+ vinaza) ≤ entrada → si no, 422 `TRC_MASS_BALANCE_EXCEEDED` (`meta: { inputLiters, outputLiters }`). Sin volumen de entrada registrado → 422 `TRC_VOLUME_MISSING`; ya cerrada → 409 `TRC_DISTILLATION_ALREADY_CLOSED`. El reposo se abre desde `processEndDate` con el `minRestDays` de la **instantánea** del lote (`mandatoryRestUntil`, `restStatus: RESTING`); con todas las destilaciones cerradas el lote pasa a `RESTING`.
- **Descartes** (`POST /v1/wine-aging/{id}/discard`, `POST /v1/production-batches/{id}/discard`): con motivo; la fuente pasa a `DISCARDED` y deja de contar como fuente abierta del embotellado. Una fuente ya embotellada o descartada → 409 `TRC_INVALID_STAGE`. El evento es interno (los motivos y las mermas no son públicos, S-22) y las incidencias abiertas del lote se reevalúan (p. ej. una fuente abierta en un lote ya embotellado).
- **Candados** (§5.3): el embotellado los recalcula siempre con la instantánea y el reloj de la base. La tarea diaria **`trace.locks.release`** (worker, 00:05 de America/La_Paz y al arrancar) solo **persiste** el estado: pasa a `READY` las crianzas `AGING` y las destilaciones `RESTING` con `unlockDate ≤ hoy` y escribe `LOCK_RELEASED` en la línea de tiempo y en la bitácora (actor sistema). Es idempotente y segura con varias réplicas (cada lote en su transacción, con su fila bloqueada). Al cerrar una destilación con una fecha que ya cumple el reposo (registro tardío), el candado se libera en el momento.

### Laboratorio del lote (§8)

`POST /v1/lots/{id}/lab-analyses` usa el mismo cálculo de conformidad y de unidades que la ruta legada (`POST /v1/lab-analyses`, alias hasta H2) y añade: lote embotellado (si no, 409 `TRC_LOT_NOT_BOTTLED`) y expediente abierto (409 `TRC_DOSSIER_CLOSED`); informe por su `key` de `POST /v1/uploads`, de la bodega y existente (422 `TRC_FILE_NOT_FOUND`), o por URL (alias hasta H2); ensayo ni futuro ni anterior al embotellado. La respuesta trae `report: { key, sha256, url }` con una URL firmada de corta vida. `GET /v1/lots/{id}/lab-analyses` lista todos, el más reciente primero, con `current: true` en el vigente (ni sustituido por un reanálisis ni anulado por una corrección). El informe del dictamen fitosanitario sigue las mismas reglas (`inspectionReportKey`, URL firmada).

### Correcciones compensatorias (§9; EA-06)

Ningún registro de la trazabilidad tiene ruta de edición ni de borrado. Un error se corrige con un **registro aparte** (`trace_corrections`): objetivo (`target.type`, `target.id`), `kind`, `changes: [{ field, before, after }]`, motivo (10–500) y autor. El recurso pasa a devolver el **valor vigente** y añade `correctedFields`, `voided` y `correctionIds`; el valor original queda en la corrección y en la bitácora (`CORRECTION_REGISTERED`), y los eventos del registro quedan marcados `corrected`.

- **`AMEND`** sobre una **lista cerrada** de campos (`src/modules/lots/domain/corrections.ts`): pesaje (`grossWeightKg`, `tareWeightKg`, `intakeDate`, `temperatureAtIntakeC`, `notes`), análisis de madurez y lecturas (sus valores y fechas), tratamiento (dosis, aditivo, proveedor, fecha, notas), tanque (`volumeFilledLiters`, `finalVolumeLiters`, `startDate`, `endDate`), crianza (`plannedMonths`, `volumeLiters`, `startDate`), destilación (`inputVolumeLiters`, cortes, `heartAbvPercent`, fechas), embotellado (`finalAlcoholAbv`, `bottleType`, `leftover`), laboratorio (sus valores y la fecha del ensayo) y parcela (`altitudeMasl`, `varietyName`, `rawMaterialType`). Otro campo → 422 `TRC_CORRECTION_FIELD_NOT_CORRECTABLE`. No son corregibles el lote de pertenencia, el tipo de producto, el código de lote, los códigos de botella ni el número de botellas.
- **`VOID`** (el registro deja de contar): lecturas, tratamientos, análisis de madurez, análisis de laboratorio y dictámenes (estos solo mientras la uva no entró a un tanque → si no, 409 `TRC_PHYTO_DECISION_FINAL`). Anular un dictamen devuelve el pesaje al estado de su último dictamen vigente; anular el análisis de laboratorio vigente devuelve la vigencia al anterior.
- **Quién** (S-17): el rol que puede crear el registro (p. ej. el operario corrige pesajes y lecturas; tanques, crianzas, destilaciones, embotellado y laboratorio, solo dirección y enología) → si no, 403 `AUTH_INSUFFICIENT_PERMISSIONS`.
- **Valores derivados**: el neto del pesaje (y las entradas del tanque, si toda la uva del pesaje estaba en tanques), el candado de la crianza y del reposo (se recalculan desde la fecha corregida, y el estado `READY`/`AGING`/`RESTING` sigue al cálculo), el metanol en mg/100 mL a.a. y la conformidad del laboratorio, y los litros disponibles del embotellado.
- **Reglas** (`lotIntegrityViolations`): cada corrección vuelve a evaluar el lote entero con su instantánea (D.O., dictamen de la uva en tanques, kilos y litros disponibles, capacidad, crianza mínima, balance de masa y, si el lote está embotellado, candados a la fecha del embotellado, balance de volumen, merma, alcohol y agua) y compara con la revisión anterior a la corrección:
  - si la corrección **introduce** una violación → 422 `TRC_CORRECTION_BREAKS_RULES` con los detalles de la regla (`code` interno, `rule`, `expected`, `actual`) y nada se guarda;
  - si la violación es de un **embotellado ya hecho** (que no se puede deshacer), la corrección se registra —el dato corregido es el verdadero— y abre una incidencia con `source: 'CORRECTION'`, que bloquea el cierre del expediente;
  - si deja de incumplirse una regla con incidencia abierta, la incidencia queda resuelta (`resolvedAt`, con la corrección que lo logró).
- **Parcelas** (`POST /v1/terroirs/{id}/corrections`, §3.1): los campos normativos de una parcela usada solo cambian por aquí (el `PATCH` responde 409 `TRC_TERROIR_IN_USE`). La corrección tiene `lotId: null` y reevalúa la D.O. de los lotes singani abiertos que usan la parcela: el que deja de cumplir recibe una incidencia `TRC_DO_NOT_ELIGIBLE` con `source: 'RULES_REEVALUATION'`; el que vuelve a cumplir, la resuelve.
- Estados que no admiten correcciones: expediente cerrado → 409 `TRC_DOSSIER_CLOSED`; lote descartado → 409 `TRC_LOT_TERMINAL`; lote `REJECTED` → solo la anulación de un dictamen (así se deshace un rechazo erróneo); registro ya anulado → 409 `CONFLICT`; fuente descartada → 409 `TRC_INVALID_STAGE`.

### Precisiones sobre el contrato

| Tema | Lo que hace el backend | Por qué |
|---|---|---|
| Tanque sin completar como origen (§5.1, §5.2) | Hasta H2, la crianza y la destilación se admiten también desde un tanque `FILLING`/`FERMENTING` (el flujo anterior a las transiciones) y lo dan por transferido; `TRC_TANK_NOT_COMPLETED` solo para `TRANSFERRED`/`CLEANED` | Compatibilidad con el ERP actual, que no llama a `complete`; no abre ninguna elusión (D.O., destino y volúmenes se comprueban igual) |
| Limpieza del tanque de un lote descartado (§4.2) | `clean` se admite desde cualquier estado si el lote está `DISCARDED` o `REJECTED` | Un lote terminal no admite transiciones: su tanque quedaría ocupado para siempre (S-7) |
| Evento del descarte de una fuente (§11.1) | `LOT_DISCARDED` interno con `data.scope: 'SOURCE'` y el recurso de la fuente; bitácora `AGING_DISCARDED`/`DISTILLATION_DISCARDED` | El contrato no define un tipo de evento para el descarte de una crianza o una destilación |
| `discardedLiters` de la crianza (§5.1) | Informativo (por defecto, todo el volumen): la crianza pasa entera a `DISCARDED` | No hay descartes parciales en el contrato |
| Corrección que incumple una regla de un embotellado ya hecho (§9) | Se registra y abre una incidencia `CORRECTION` (no 422) | El embotellado no se puede deshacer y el dato corregido es el verdadero; el 422 se reserva para lo que aún se puede evitar |
| Cómo se guarda una corrección (§9) | El registro pasa a tener el valor vigente; el anterior queda en `trace_corrections.changes` y en la bitácora | Todas las reglas y vistas leen un único valor vigente; no hay rutas de edición ni de borrado |
| Eventos del outbox `lot.*` (§15) | No se emiten todavía | Su único consumidor es la caché del pasaporte (paso 2.10); un evento sin procesador falla en el worker |

## Migración de los datos anteriores (§2.6)

1. **Expandir** (`20260928090000_o2_lotes_expand`): tablas nuevas y columnas nulas; la migración **encola** cada pesaje existente en `lot_backfill_pending`.
2. **Relleno** (`LotBackfillRunner`, al arrancar la API y sin bloquear el arranque; `LOT_BACKFILL_ON_BOOT=false` lo desactiva): cada pesaje en su propia transacción con `FOR UPDATE SKIP LOCKED` (varias instancias se reparten la cola), hasta 5 intentos con `last_error`. Por pesaje (`backfillHarvestChain`, idempotente: un pesaje con lote no se toca):
   - **Un lote por pesaje** (la regla de `LotView`), id **UUID v5 de `lot:{harvestBatchId}`** en el espacio de nombres de los mocks (`6b2f4c1e-…`), nombre = código de lote si está embotellado o `'{variedad} {año}'`, `productType` derivado (destilación o tanque a singani → `SINGANI`; crianza o tanque a vino → `WINE`; si no, nulo), referencia con la secuencia nueva y `lotCode` del embotellado.
   - **Instantánea** con `origin: 'MIGRATION'` tomada al migrar.
   - **Dictamen**: cada estado distinto de `PENDING_INSPECTION` genera un `PhytoDecision` `MIGRATION` con `certifiedByMemberId` como autor. Brix, pH y acidez generan el primer `MaturityAnalysis` (salvo 0/0/0, que en los datos anteriores significaba "sin análisis").
   - **Entradas de tanque**: el neto del pesaje; con varios tanques del mismo pesaje, repartido por volumen llenado (así no se cuenta dos veces).
   - Crianza con `start_date` (su fecha de alta en La Paz); cortes de la destilación desde `additionalParams` y el grado del corazón desde `initialAlcoholPercentage`.
   - **Laboratorio**: conformidad recalculada con la instantánea (el `conformsToSenasagStandards` guardado queda como histórico).
   - **Códigos de botella** para los embotellados existentes y `qrBatchUrl` reescrita a `{PASSPORT_BASE_URL}/b/{lotCode}`.
   - Línea de tiempo con los hechos a sus fechas y una entrada de bitácora `LOT_MIGRATED` (actor sistema).
   - **Revisión de integridad**: D.O. del lote singani, dictamen de la uva en tanques, candado a la fecha del embotellado, balance de volumen y alcohol, agua en vino, volumen de la fuente, salidas del tanque por encima de su volumen, un segundo embotellado del mismo lote y fuentes abiertas en un lote embotellado. Lo que no cumple **no se borra ni se corrige solo**: queda como `ComplianceIssue` `MIGRATION` visible en el lote (y bloquea embotellar hasta corregirlo o descartar el lote).
3. Un registro anterior que aún no tenga lote (p. ej. si el relleno falló) se rellena **al vuelo** en cuanto una escritura lo necesita (`ensureHarvestLot`).
4. **Contraer** (cierre de la ola, H2): `lot_id NOT NULL` salvo en pesajes, `Restrict` en las claves antiguas y retirada de lo legado (§16.2).

Probado sobre una copia con la semilla de demostración anterior a la migración (Postgres 16): 12 pesajes → 12 lotes, 15.400 códigos de botella, 95 eventos, 10 dictámenes, 11 análisis de madurez, 3 análisis de laboratorio conformes y 4 incidencias en los datos que no cumplían (ver [Semilla](#semilla)). La e2e `traceability-o2` repite el relleno sobre datos anteriores creados a mano (incidencias `TRC_DO_NOT_ELIGIBLE` y `TRC_BOTTLING_EXCEEDS_VOLUME`) y comprueba que una segunda pasada no toca nada.

### Semilla

La semilla determinista (`pnpm seed`) rellena sus lotes con la misma función y aplica **correcciones de realismo** (`src/seed/corrections.ts`) a los fixtures de los mocks 0.3.x que incumplían las reglas nuevas, sin falsear datos:

| Registro | Corrección | Por qué |
|---|---|---|
| CVJ-2026-SINGANI-002 | Agua 620 L → 630 L | 2.140 × 75 cL = 1.605 L con solo 1.600 L disponibles (980 L de corazón + 620 L) |
| Destilación AL-02 de marzo de 2026 (TK-02) | Se retira | El tanque ya se destiló entero en 2025 y su lote se embotelló en febrero de 2026 |
| Tanque TK-07 | Se retira | Lleno con un pesaje en cuarentena |
| Crianza de CVJ-2026-WINE-003 | `READY` → `BOTTLED` | Ya estaba embotellada |

Con ellas la semilla no genera incidencias. Una base que ya tenía la semilla anterior conserva esos registros y los muestra como incidencias de la migración (así se comporta con datos reales). Los mocks v2 (O2-PK-1) deben adoptar las mismas correcciones y el id de lote `uuidv5('lot:{harvestBatchId}')`.

## Rutas

Implementadas en la apertura (con su OpenAPI y validadas contra él en e2e): `GET/POST /v1/lots`, `GET/PATCH /v1/lots/{id}`, `POST /v1/lots/{id}/discard`; `POST /v1/lots/{id}/bottling/preview` y `POST /v1/lots/{id}/bottling` (mismo motor que la ruta legada; sin `sources`, todas las fuentes abiertas del lote con todo su volumen); `POST/GET /v1/harvest-batches/{id}/phyto-decisions` y `…/maturity-analyses`; `GET /v1/harvest-batches?lotId=none`; y las rutas actuales con las reglas nuevas y los campos aditivos (`lotId`, `inputs`, `lock`, `balance`, `bottleCodes`, `conformity`, `units`…). `GET /v1/public/wineries` también responde (O2-WEB-1).

Implementadas en los pasos 2.3, 2.4 y 2.7 ([arriba](#vinificación-crianza-y-destilación-laboratorio-y-correcciones-pasos-2224-y-27)): transiciones del tanque, descarte de crianza, cierre y descarte de destilación, laboratorio por lote y correcciones.

Publicadas con **501 `NOT_IMPLEMENTED`** (el `details[0].meta.step` dice el paso de la Etapa 2 que las trae): códigos de botella y exportaciones (2.6), expediente (2.8), línea de tiempo, grafo, balance, panel, reportes y adjuntos (2.9) y pasaporte público (2.10).

## Configuración

| Variable | Uso |
|---|---|
| `PASSPORT_BASE_URL` | Base del QR: `{PASSPORT_BASE_URL}/b/{código}` (OP-06). Por defecto `APP_URL_MARKETPLACE`; si tampoco, `http://localhost:3005` |
| `LOT_BACKFILL_ON_BOOT` | `false` desactiva el relleno al arrancar (por defecto activo) |
