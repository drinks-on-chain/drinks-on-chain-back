# Módulos del Sistema — Drinks on Chain

> **Scope:** Backend únicamente — Supabase (DB + Edge Functions + Storage) + Stellar Soroban  
> **Arquitectura:** Multi-tenant con RLS. Un tenant = una bodega (winery).  
> **Nota:** No hay frontend en este proyecto. Las APIs son consumidas por aplicaciones externas.

---

## Sistema 1 — ERP de Trazabilidad B2B

> **Consumidores de la API:** App de bodega (web/móvil, construida por separado)  
> **Actores:** Administrador de bodega, Enólogo, Agrónomo, Operario

### M1.1 — Gestión de Productores y Terroirs

**Propósito:** Registro y administración de los productores (bodegas) y sus tierras de cultivo.

**Endpoints PostgREST (auto):**
```
GET    /wineries                          -- Lista de bodegas del admin Debro
GET    /wineries/{id}                     -- Detalle de una bodega
GET    /terroirs?winery_id=eq.{id}        -- Terroirs de una bodega
POST   /terroirs                          -- Crear nuevo terroir
PATCH  /terroirs/{id}                     -- Actualizar terroir
```

**Edge Functions:**
```
POST /functions/v1/register-producer      -- Debro aprueba bodega → registro on-chain C-01
POST /functions/v1/create-wallet          -- Crea wallet Stellar (Dynamic) para bodega/usuario
```

**Reglas de negocio:**
- Un terroir marcado como `is_do_eligible = true` para Singani debe tener `altitude_masl > 1600`
- Validación de que la variedad de uva sea `Moscatel de Alejandría` para D.O. Singani
- `geographic_polygon_geojson` es opcional en MVP, obligatorio en Fase 2 (exportación)
- Solo un `PLATFORM_ADMIN` puede aprobar una bodega

**Extensibilidad:**
- La entidad `terroirs` usa `grape_variety` como campo libre para soportar cualquier cultivo futuro (cebada para cerveza, agave, etc.)
- El campo `beverage_category` en `wineries` puede extenderse a `WINERY`, `BREWERY`, `DISTILLERY`

---

### M1.2 — Gestión de Cosechas

**Propósito:** Registro de cada lote de materia prima desde el ingreso a la planta.

**Endpoints PostgREST (auto):**
```
GET    /harvest-batches?winery_id=eq.{id}
GET    /harvest-batches/{id}
POST   /harvest-batches
PATCH  /harvest-batches/{id}
```

**Campos calculados (vistas de BD):**
```sql
-- Vista: harvest_batches_summary
-- net_weight_kg = gross_weight_kg - tare_weight_kg (calculado automáticamente)
CREATE VIEW harvest_batches_summary AS
SELECT *, gross_weight_kg - tare_weight_kg AS net_weight_kg
FROM harvest_batches;
```

**Endpoints PostgREST (auto):**
```
GET    /harvest-batches?winery_id=eq.{id}
GET    /harvest-batches/{id}
POST   /harvest-batches
PATCH  /harvest-batches/{id}
```

**Reglas de negocio:**
- `phytosanitary_status` solo puede ser cambiado a `APPROVED` por un `ENOLOGIST` o `AGRONOMIST`
- Un lote con `phytosanitary_status != 'APPROVED'` no puede vincularse a un `fermentation_tank`
- `certified_by_enologist_id` es obligatorio al aprobar

---

### M1.3 — Fermentación y Tratamientos Enológicos

**Propósito:** Control del proceso de fermentación y todos los aditivos aplicados.

**Endpoints PostgREST (auto):**
```
GET    /fermentation-tanks?winery_id=eq.{id}
POST   /fermentation-tanks
PATCH  /fermentation-tanks/{id}
GET    /fermentation-logs?fermentation_tank_id=eq.{id}&order=recorded_at.desc
POST   /fermentation-logs
GET    /enological-treatments?fermentation_tank_id=eq.{id}
POST   /enological-treatments
```

**Supabase Realtime:**
```
-- Canal: fermentation_logs:{tank_id}
-- Permite monitoreo en tiempo real de temperatura y densidad
-- Útil para alertas automáticas cuando temperatura sale de rango
```

**Reglas de negocio:**
- `senasag_chemical_authorization_code` es **requerido** en todos los tratamientos
- Un `fermentation_tank` debe tener `destination_type` definido antes de cerrarse
- El `authorized_by_enologist_id` debe ser miembro activo de la bodega con rol `ENOLOGIST`
- Los `fermentation_logs` son append-only (nunca se editan)

**Alertas (DB Trigger o CRON):**
```
Si temperatura_celsius > 30°C → INSERT notification { type: 'HIGH_TEMP_ALERT', tank_id }
Si specific_gravity < 1.000 y status != 'COMPLETED' → alerta de fermentación completa
```

---

### M1.4 — Bifurcación: Crianza de Vino y Destilación de Singani/Destilados

**Propósito:** Gestión de las rutas de producción específicas post-fermentación.

**Endpoints PostgREST (auto):**
```
GET    /wine-aging-batches?winery_id=eq.{id}
POST   /wine-aging-batches
PATCH  /wine-aging-batches/{id}

GET    /singani-distillation-batches?winery_id=eq.{id}
POST   /singani-distillation-batches
PATCH  /singani-distillation-batches/{id}
```

**Extensibilidad — Nuevas Bebidas:**
```
El sistema está diseñado para soportar nuevas rutas de producción:
- Cerveza: POST /beer-fermentation-batches (futura entidad)
- Ron: POST /rum-distillation-batches (futura entidad)
- Cualquier destilado: usa singani_distillation_batches con product_type != 'SINGANI'

El campo product_type en bottling_batches es el identificador final.
```

**CRON Jobs en Supabase:**
```sql
-- Cada hora: desbloquear lotes listos para embotellar
UPDATE wine_aging_batches
SET aging_status = 'READY'
WHERE aging_status = 'AGING' AND lock_until_date <= CURRENT_DATE;

UPDATE singani_distillation_batches
SET rest_status = 'READY'
WHERE rest_status = 'RESTING' AND mandatory_rest_lock_until <= CURRENT_DATE;
```

---

### M1.5 — Laboratorio y Análisis Físico-Químico

**Propósito:** Ingreso de boletines analíticos de laboratorio certificado. Son requisito para tokenización y futura exportación.

**Endpoints PostgREST (auto):**
```
GET    /batch-lab-analyses?bottling_batch_id=eq.{id}
POST   /batch-lab-analyses
PATCH  /batch-lab-analyses/{id}
```

**Supabase Storage:**
```
POST /storage/v1/object/lab-reports/{winery_id}/{bottling_batch_id}/report.pdf
```

**Reglas de negocio:**
- Un lote solo puede tener UN análisis oficial (un POST; edición vía PATCH si hay corrección)
- Si `conforms_to_senasag_standards = false`, el lote no puede ser liberado para tokenización
- El PDF del boletín es requerido (`laboratory_report_pdf_url NOT NULL`)
- Solo `ENOLOGIST` puede marcar el análisis como conforme

**Internacionalización de parámetros:**
- Los nombres de parámetros tienen etiquetas en `enum_labels` con `es` e `en`
- La API puede devolver las etiquetas en el idioma solicitado via `Accept-Language` header

---

### M1.6 — Embotellado y Anclaje Blockchain

**Propósito:** Registro del proceso final de embotellado y anclaje del hash en Stellar.

**Endpoints:**
```
GET    /bottling-batches?winery_id=eq.{id}        -- PostgREST
POST   /bottling-batches                           -- PostgREST
PATCH  /bottling-batches/{id}/release              -- Edge Function (requiere lab conforme)
GET    /bottling-batches/{id}/anchor-status        -- Edge Function (consulta C-02)
```

**Edge Function `anchor-batch`** (disparada por DB trigger al liberar):
```
Input:  bottling_batch_id
Steps:
  1. SELECT bottling_batches + batch_lab_analyses (JOIN)
  2. Serializa como JSON canónico
  3. SHA-256(JSON) = data_hash
  4. Stellar: C-02.anchor_batch(batch_id, data_hash, producer_id, product_type)
  5. UPDATE bottling_batches SET blockchain_anchor_tx_hash = tx_hash
Output: { tx_hash, data_hash, anchored_at }
```

**Generación del Código de Lote Internacional (GS1):**
```
international_lot_code = {WINERY_CODE}-{YEAR}-{PRODUCT_TYPE}-{SEQUENCE}
Ejemplo: KOH-2023-WINE-0042
         BOD-2024-SING-0018
```

**QR de lote (campo `qr_batch_url` en `bottling_batches`):**
```
Generado al liberar el lote (CRON del indexer confirma is_anchored_on_chain = true).
Formato: https://api.drinks-on-chain.com/public/batch/{international_lot_code}
Se imprime estáticamente en la etiqueta de la botella.

El endpoint /public/batch/{lot_code} responde dinámicamente:
  - Si la colección NO existe aún: muestra solo trazabilidad (bodega, lab, blockchain)
  - Si la colección SÍ existe: agrega precio, disponibilidad, link de compra
El QR físico NUNCA cambia. El contenido del endpoint sí.
```

**QR de claim** → Este es diferente. Ver M2.5 y `docs/analisis/06-interfaz-pagos-y-qr.md`.

---

## Sistema 2 — Tokenización y Marketplace

> **Consumidores de la API:** App B2C del consumidor  
> **Actores:** Admin Debro (backoffice), Consumidor final

### M2.1 — Gestión de Colecciones NFT

**Propósito:** El backoffice de Debro crea y gestiona las colecciones de botellas tokenizadas.

**Endpoints:**
```
GET    /collections?publication_status=eq.PUBLISHED    -- Lista pública
GET    /collections/{id}                               -- Detalle con JOIN a bottling_batch
POST   /collections                                    -- Admin Debro crea colección
PATCH  /collections/{id}/publish                       -- Edge Function: publica + genera token records
PATCH  /collections/{id}/pause                         -- Admin pausa ventas
```

**Edge Function al publicar:**
```
POST /functions/v1/publish-collection
Input:  collection_id
Steps:
  1. Verifica bottling_batch.is_anchored_on_chain == true
  2. INSERT N registros en tokenized_items (token_status: 'UNMINTED')
     bottle_serial_number: 1..total_supply
  3. Genera metadata JSON para cada token y sube a Storage (nft-metadata bucket)
  4. Calcula metadata_hash para cada token
  5. UPDATE collections.publication_status = 'PUBLISHED'
Output: { collection_id, tokens_created: N }
```

---

### M2.2 — Onboarding de Consumidores y Wallets

**Propósito:** Registro de consumidores B2C con creación automática de wallet invisible.

**Endpoints (NestJS):**
```
POST /auth/signup                  -- Registro con email + password
POST /auth/login                   -- Login, retorna JWT
GET  /users/me/wallet              -- Wallet del usuario autenticado
```

**Flujo de onboarding:**
```
1. Consumidor hace POST /auth/signup { email, password, full_name }
2. NestJS crea el usuario en DB
3. AuthService llama WalletService.createForUser():
   → Llama Dynamic API: crea wallet Stellar custodial
   → INSERT user_wallets { stellar_public_address, dynamic_vault_id }
4. Consumidor recibe email de verificación (via SendGrid o similar)
5. Ya puede ver el catálogo y comprar
```

---

### M2.3 — Flujo de Compra (Payment + Mint)

**Propósito:** Gestionar la compra de botellas tokenizadas con pago fiat externo y mint automático.

**Endpoints (NestJS):**
```
POST /orders                       -- Crea orden + cobro en plataforma de pagos
POST /webhooks/payments            -- Webhook del proveedor de pagos (público, firmado)
GET  /orders                       -- Historial de órdenes del usuario (JWT)
GET  /orders/:id                   -- Detalle con order_items y tokenized_items
```

**Idempotencia del payment-callback:**
```sql
-- Previene doble-mint si el webhook se llama dos veces
CREATE UNIQUE INDEX idx_orders_charge_id 
ON orders(payment_gateway_reference) 
WHERE payment_gateway_reference IS NOT NULL;
```

**Pre-venta (diseñado pero no activo en MVP):**
```
En pre-venta, el flujo es idéntico EXCEPTO:
- En el paso 3 de la compra, no hay tokenized_items disponibles aún
- El orden queda en status: 'PRESALE_CONFIRMED'
- Cuando el lote es producido y anclado:
  → Sistema genera los tokenized_items
  → Edge Function 'fulfill-presale-orders' mintea a todos los pre-compradores
- La tabla orders tiene el campo presale_eligible para soportar esto
```

---

### M2.4 — Cava Digital (Inventario NFT del Consumidor)

**Propósito:** Vista de todos los NFTs que posee un consumidor y gestión de retiros.

**Endpoints:**
```
GET /tokenized-items?current_owner_user_id=eq.{id}     -- NFTs del usuario
GET /tokenized-items/{id}                              -- Detalle con info del lote
GET /claim-passes?user_id=eq.{id}                     -- Passes activos/histórico
GET /claim-redemptions?user_id=eq.{id}                -- Historial de retiros
```

**Endpoint público del QR (sin autenticación):**
```
GET /public/product/{token_id}         -- Info pública del token (ver Flujo 6)
GET /public/batch/{lot_code}           -- Info pública del lote por código
```

---

### M2.5 — Claim Pass y Retiro Físico

**Endpoints (NestJS):**
```
POST /claims/passes                  -- Genera pass + ancla hash en C-05
DELETE /claims/passes/:id            -- Revoca pass activo en C-05
POST /claims/validate                -- POS valida un QR escaneado
POST /claims/burn                    -- POS confirma entrega y ejecuta burn on-chain
GET  /pos/shifts/:id/summary         -- Resumen del turno para el POS
PATCH /pos/shifts/:id/close          -- Cierra el turno
```

---

### M2.6 — Reviews y Notas de Cata

**Propósito:** Los consumidores que retiraron físicamente su botella pueden calificar y dejar notas de cata.

**Endpoints (NestJS):**
```
POST /product-reviews              -- Crear review (requiere claim_redemption previo)
GET  /product-reviews/collection/:id -- Reviews públicos de una colección
GET  /product-reviews/my           -- Mis reviews (JWT)
```

**Reglas:**
- Solo puede dejar review quien haya quemado un NFT de esa colección
- 1 review por botella retirada
- Debro puede moderar (`is_visible = false`)

---

## Sistema 3 — Backoffice Debro Solutions

> **Consumidores de la API:** Herramienta interna de Debro (construida por separado)  
> **Actores:** Admin Debro, Equipo de soporte

### M3.1 — Onboarding y Certificación de Bodegas

**Endpoints (NestJS):**
```
POST /wineries                         -- Crear bodega
POST /wineries/:id/approve             -- Aprobar + registrar on-chain (C-01)
POST /wineries/:id/revoke              -- Revocar bodega en C-01
GET  /wineries?status=PENDING          -- Bodegas en revisión
POST /winery-members                   -- Añadir miembro a bodega
```

---

### M3.2 — Motor de Tokenización (Panel de Colecciones)

```
GET  /collections                           -- Todas las colecciones (admin ve todas)
GET  /collections?publication_status=eq.PENDING_APPROVAL
POST /functions/v1/publish-collection       -- Aprobar y publicar
GET  /tokenized-items?token_status=eq.MINTED  -- NFTs en circulación
GET  /tokenized-items?token_status=eq.BURNED  -- NFTs quemados (retiros)
```

---

### M3.3 — Gestión de POS y Puntos de Retiro

```
POST /pickup-locations                      -- Crear punto de retiro
PATCH /pickup-locations/{id}               -- Actualizar (activar/desactivar)
POST /functions/v1/register-pos            -- Registra dirección POS en C-05
GET  /pos-shifts                           -- Historial de turnos
GET  /claim-redemptions                    -- Historial global de retiros
```

---

### M3.4 — Soporte y Auditoría

```
GET  /support-tickets                      -- Todos los tickets (admin)
PATCH /support-tickets/{id}               -- Gestionar ticket
GET  /audit-logs?entity_type=eq.{type}    -- Logs de auditoría
GET  /blockchain-events?contract_address=eq.{addr}  -- Eventos on-chain indexados
```

---

## Sistema 4 — Terminal POS de Claim

> **Consumidores de la API:** App POS (PWA o móvil, construida por separado)  
> **Actores:** Operador de punto de retiro

```
POST /auth/v1/token (PIN hash como password)   -- Autenticación del POS
POST /pos-shifts                               -- Apertura de turno
POST /functions/v1/validate-claim              -- Validar QR (respuesta < 2 seg)
POST /functions/v1/burn-claim                  -- Ejecutar burn post-confirmación
GET  /pos-shifts/{id}/summary                  -- Resumen del turno
PATCH /pos-shifts/{id}/close                   -- Cerrar turno
```

**Consideraciones de performance:**
- `/validate-claim` debe responder en < 2 segundos (experiencia del operador en mostrador)
- Supabase Edge Functions corren en Deno Deploy → latencia global baja
- La verificación on-chain (C-05) se hace en paralelo con la verificación off-chain (Supabase)

---

## APIs Públicas (Sin Autenticación)

```
GET /public/product/{token_id}           -- Trazabilidad pública de una botella
GET /public/batch/{lot_code}             -- Trazabilidad pública de un lote completo
GET /public/producer/{producer_id}       -- Perfil público de una bodega
```

**Rate limiting:** Aplicado via Supabase Edge para prevenir abuso.

---

## Internacionalización (i18n) en el Backend

```
Cabecera HTTP: Accept-Language: es | en | es-BO

La API devuelve campos de texto según el idioma solicitado:
{
  "name": "Cabernet Sauvignon Reserva 2023",   // campo base (español)
  "name_localized": "Cabernet Sauvignon Reserve 2023",  // según Accept-Language
  "description_localized": "Aged red wine...",
}

Tabla enum_labels en Supabase:
  enum_name | enum_value | locale | label
  "beverage_type" | "WINE" | "es" | "Vino"
  "beverage_type" | "WINE" | "en" | "Wine"
  "beverage_type" | "SINGANI" | "es" | "Singani"
  "beverage_type" | "SINGANI" | "en" | "Singani (Bolivian spirit)"
```

---

## Matriz de Endpoints por Actor

| Endpoint / Función | PLATFORM_ADMIN | WINERY_ADMIN | ENOLOGIST | AGRONOMIST | CONSUMER | POS_OPERATOR |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `GET /wineries` | ✅ todos | ✅ propio | ✅ propio | ✅ propio | ❌ | ❌ |
| `POST /terroirs` | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /harvest-batches` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `PATCH harvest: approve` | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| `POST /fermentation-logs` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `POST /enological-treatments` | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `PATCH bottling: release` | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `POST /collections` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `publish-collection` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `GET /collections (public)` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `create-order` | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| `generate-claim-pass` | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| `validate-claim` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `burn-claim` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `GET /public/product/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
