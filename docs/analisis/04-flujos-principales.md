# Flujos Principales del Sistema — Drinks on Chain

> Descripción de los flujos end-to-end del MVP. Cada flujo describe los actores, pasos y contratos/tablas involucrados.

---

## Flujo 1 — Onboarding de Bodega (Productor)

```
Actor: Admin Debro Solutions
Resultado: Bodega activa con wallet Stellar y registrada on-chain
```

```
1. Admin Debro crea la bodega en Backoffice
   POST /wineries { legal_name, tax_id_nit, senasag_sanitary_reg, ... }
   → BD: wineries.certification_status = 'PENDING'

2. Admin sube documentos de la bodega a Supabase Storage
   (Registro sanitario SENASAG, NIT, etc.)

3. Admin revisa y aprueba la bodega
   PATCH /wineries/{id}/approve
   → Edge Function 'register-producer' se activa:
     a. Llama Dynamic API → crea wallet Stellar para la bodega
     b. Guarda address en user_wallets { winery_id, stellar_public_address, wallet_type: CUSTODIAL }
     c. Calcula SHA-256 del JSON de la bodega (metadata_hash)
     d. Firma y envía tx → C-01.register_producer(producer_id, stellar_address, metadata_hash)
     e. Guarda tx_hash en wineries.onchain_producer_id
   → BD: wineries.certification_status = 'ACTIVE'

4. Indexer detecta evento ProducerRegistered on-chain
   → Confirma is_anchored = true en Supabase

5. Admin invita a miembros (enólogos, agrónomos) a la bodega
   POST /winery-members { user_id, winery_id, member_role, professional_license_number }
```

---

## Flujo 2 — ERP: Trazabilidad Completa de un Lote

```
Actor: Enólogo / Agrónomo de la bodega
Resultado: Lote embotellado con hash anclado en la blockchain
```

### 2A — Cosecha

```
1. Agrónomo registra el terroir (si es nuevo)
   POST /terroirs { parcel_name, grape_variety, altitude_masl, is_do_eligible, ... }

2. Agrónomo crea lote de cosecha
   POST /harvest-batches {
     terroir_id, harvest_batch_code,
     gross_weight_kg, tare_weight_kg,
     brix_degrees, initial_ph, initial_acidity_gl,
     phytosanitary_status: 'PENDING_INSPECTION'
   }

3. Enólogo aprueba el estado fitosanitario
   PATCH /harvest-batches/{id} { phytosanitary_status: 'APPROVED', certified_by_enologist_id }
   [REGLA: Solo puede pasar a fermentación si status = 'APPROVED']
```

### 2B — Fermentación

```
4. Enólogo crea tanque de fermentación
   POST /fermentation-tanks {
     harvest_batch_id, tank_code, destination_type: 'WINE' | 'SINGANI',
     volume_filled_liters, start_date
   }

5. Operarios registran logs de control
   POST /fermentation-logs {
     fermentation_tank_id, temperature_celsius, specific_gravity, recorded_at
   }
   [Puede ser llamado periódicamente por un sensor IoT o manualmente]

6. Enólogo registra tratamientos enológicos aplicados
   POST /enological-treatments {
     fermentation_tank_id, treatment_type, additive_name,
     dosage_applied_g_per_hl, senasag_chemical_authorization_code,
     authorized_by_enologist_id
   }
   [REGLA: senasag_chemical_authorization_code es requerido para todos los aditivos]
```

### 2C — Bifurcación: Ruta Vino

```
7a. Enólogo crea lote de crianza
    POST /wine-aging-batches {
      fermentation_tank_id, barrel_type_origin,
      planned_months, lock_until_date
    }
    [REGLA: lock_until_date = start_date + planned_months]
    [REGLA: No puede embotellarse hasta que aging_status = 'READY' y lock_until_date ha pasado]

8a. Cuando la crianza termina, enólogo marca como listo
    PATCH /wine-aging-batches/{id} { aging_status: 'READY' }
```

### 2D — Bifurcación: Ruta Singani

```
7b. Enólogo registra destilación
    POST /singani-distillation-batches {
      fermentation_tank_id, alembic_identifier,
      head_cut_liters, heart_cut_liters, tail_cut_liters,
      initial_alcohol_percentage,
      mandatory_rest_lock_until,  -- reposo obligatorio
      do_singani_eligible
    }

8b. Cuando termina el reposo, el sistema automáticamente habilita el embotellado
    [CRON Job en Supabase: PATCH rest_status = 'READY' cuando now() > mandatory_rest_lock_until]
```

### 2E — Embotellado

```
9. Enólogo crea el lote de embotellado
   POST /bottling-batches {
     wine_aging_batch_id | singani_distillation_batch_id,
     international_lot_code,      -- Generado automáticamente (GS1)
     product_type,                -- 'WINE' | 'SINGANI'
     final_alcohol_abv,
     total_bottles_packaged,
     packaging_format_cl,         -- 75, 70, 50, etc.
     water_dilution_liters,       -- Solo para Singani
     bottling_date
   }
   [REGLA: Solo puede embotellar si la ruta origen tiene status = 'READY']

10. Laboratorio carga el análisis físico-químico
    POST /batch-lab-analyses {
      bottling_batch_id,
      certified_laboratory_name, accredited_lab_certification_code,
      actual_alcohol_abv, total_acidity_tartaric_gl,
      volatile_acidity_acetic_gl, free_sulfur_dioxide_mg_l,
      total_sulfur_dioxide_mg_l, methanol_content_mg_l,
      laboratory_report_pdf_url,
      conforms_to_senasag_standards  -- MVP: solo SENASAG
    }

11. Enólogo libera el lote (firma digital)
    PATCH /bottling-batches/{id} { released_by_enologist_id: uuid }
    [REGLA: Solo puede liberar si hay un batch_lab_analysis con conforms_to_senasag_standards = true]

12. DB Trigger detecta la liberación del lote
    → Activa Edge Function 'anchor-batch':
      a. Obtiene JSON completo del lote + análisis de lab
      b. Calcula SHA-256 = data_hash
      c. Firma y envía tx → C-02.anchor_batch(batch_id, data_hash, producer_id, batch_type)
      d. Guarda tx_hash en bottling_batches.blockchain_anchor_tx_hash

13. Indexer detecta evento BatchAnchored on-chain
    → Actualiza bottling_batches.is_anchored_on_chain = true
    → Supabase Realtime notifica a la bodega
```

---

## Flujo 3 — Tokenización de un Lote

```
Actor: Admin Debro Solutions
Precondición: bottling_batches.is_anchored_on_chain = true
Resultado: Colección de NFTs publicada y disponible para compra
```

```
1. Admin Debro revisa el lote en el backoffice
   GET /bottling-batches/{id} (con todas las relaciones: lab, terroir, tratamientos)

2. Admin crea la colección (configura el NFT)
   POST /collections {
     bottling_batch_id,
     name_es, name_en,
     description_es, description_en,
     cover_image_url,            -- Sube imagen a Storage primero
     distributor_price_usd,
     total_supply,               -- Debe ser <= bottling_batches.total_bottles_packaged
     sale_starts_at
   }
   → BD: collections.publication_status = 'PENDING_APPROVAL'

3. Sistema genera los registros de tokenized_items (uno por botella)
   [Edge Function o DB trigger: INSERT N registros en tokenized_items con bottle_serial_number 1..N]
   → BD: token_status = 'UNMINTED'

4. Sistema genera la metadata JSON de cada token y la sube a Storage
   [Edge Function: genera metadata compatible con estándares NFT y la sube a nft-metadata bucket]

5. Admin aprueba la colección para publicación
   PATCH /collections/{id}/publish
   → BD: publication_status = 'PUBLISHED', sale_starts_at activo
   → API ahora devuelve la colección en el catálogo público
```

---

## Flujo 4 — Compra y Mint de NFT

```
Actor: Consumidor B2C
Precondición: collections.publication_status = 'PUBLISHED', tokens disponibles (UNMINTED)
Resultado: NFT minteado en la wallet del comprador
```

```
1. Consumidor se registra / inicia sesión
   POST /auth/signup { email, password }
   → Supabase Auth crea usuario
   → Edge Function 'create-wallet':
     Llama Dynamic API → crea wallet Stellar
     INSERT user_wallets { user_id, stellar_public_address, dynamic_vault_id, wallet_type: 'CUSTODIAL' }

2. Consumidor selecciona una colección y cantidad a comprar
   GET /collections/{id}  → ve precio, disponibilidad, info del lote
   POST /orders { collection_id, quantity: 1 }
   → BD: orders { status: 'PENDING', payment_status: 'PENDING' }
   → BD: tokenized_items de cantidad solicitada cambian a token_status: 'RESERVED'

3. Backend crea el cobro en la Plataforma de Pagos
   [Edge Function: llama API de la plataforma de pagos]
   createCharge({
     amount: collection.distributor_price_usd * quantity,
     currency: "USD",
     metadata: {
       order_id: order.id,
       user_id: user.id,
       collection_id: collection.id,
       quantity: quantity
     },
     webhook_url: "/functions/v1/payment-callback"
   })
   → Plataforma devuelve { checkout_url, charge_id }
   → BD: orders.payment_gateway_reference = charge_id
   → Backend devuelve { checkout_url } al consumidor

4. Consumidor completa el pago en el checkout de la plataforma

5. Plataforma de Pagos llama el webhook del backend
   POST /functions/v1/payment-callback
   {
     charge_id: "...",
     status: "COMPLETED",
     metadata: { order_id, user_id, collection_id, quantity }
   }
   → Edge Function 'payment-callback':
     a. Valida la firma del webhook (HMAC con PAYMENT_PLATFORM_WEBHOOK_SECRET)
     b. Verifica idempotencia: ¿ya procesamos este charge_id?
     c. Obtiene la orden → verifica status = 'PENDING'
     d. Actualiza: orders.payment_status = 'PAID', orders.paid_at = now()

6. Edge Function dispara 'mint-nft' para cada token reservado de la orden:
   a. Obtiene user_wallets.stellar_public_address del comprador
   b. Obtiene tokenized_items reservados para esta orden
   c. Para cada token:
      - Calcula metadata_hash = SHA-256(metadata JSON del token)
      - Firma y envía tx → C-03.mint(buyer_address, token_id, collection_id, metadata_hash)
      - Guarda: tokenized_items.mint_tx_hash = stellar_tx_hash
      - Actualiza: tokenized_items.current_owner_user_id = user.id

7. Indexer detecta evento ProductMinted on-chain
   → Actualiza tokenized_items.token_status = 'MINTED'
   → Supabase Realtime notifica al consumidor (si está conectado)

Resultado: El consumidor tiene el NFT en su wallet invisible (Dynamic)
```

---

## Flujo 5 — Retiro Físico (Claim & Burn)

```
Actores: Consumidor B2C + Operador POS
Precondición: tokenized_items.token_status = 'MINTED'
Resultado: NFT quemado, botella física entregada
```

```
[PARTE 1: Consumidor genera el Claim Pass]

1. Consumidor solicita retirar su botella
   POST /claim-passes {
     tokenized_item_id,
     pickup_location_id,
     expires_at: now() + 24h  -- configurable
   }
   
2. Edge Function 'generate-claim-pass':
   a. Verifica que tokenized_item.current_owner_user_id == auth.uid()
   b. Verifica que token_status == 'MINTED'
   c. Verifica que no existe un claim_pass ACTIVE para este token
   d. Genera: nonce = random bytes
      pass_payload = { token_id, user_id, pickup_location_id, expires_at, nonce }
      pass_hash = SHA-256(pass_payload)
      qr_payload = JSON stringify del pass_payload
   e. Firma y envía tx → C-05.generate_pass(token_id, owner_wallet, pass_hash, expires_at)
   f. INSERT claim_passes {
        tokenized_item_id, user_id, pickup_location_id,
        ephemeral_qr_payload: qr_payload,
        onchain_pass_hash: pass_hash,
        onchain_generate_tx_hash: stellar_tx_hash,
        expires_at,
        pass_status: 'ACTIVE'
      }
   g. Devuelve: { qr_payload, expires_at }
   
3. Consumidor muestra el QR en la app (generado desde qr_payload)
   [QR es estático durante su ventana de validez]

[PARTE 2: POS valida y ejecuta el burn]

4. Operador POS abre turno
   POST /pos-shifts { pickup_location_id, cashier_user_id }
   [Autenticación via PIN hash de la sucursal]

5. POS escanea el QR del consumidor
   → Obtiene: { token_id, user_id, pickup_location_id, expires_at, nonce }
   
6. POS llama al backend para validar
   POST /functions/v1/validate-claim {
     qr_payload: (contenido del QR escaneado),
     pos_shift_id: (turno activo)
   }
   → Edge Function 'validate-claim':
     a. Decodifica qr_payload
     b. Recalcula pass_hash = SHA-256(qr_payload)
     c. Busca claim_passes donde onchain_pass_hash = pass_hash
     d. Verifica:
        - pass_status == 'ACTIVE'
        - expires_at > now()
        - pickup_location_id == el del POS actual
        - tokenized_items.token_status == 'MINTED'
        - C-05.get_pass_status(pass_hash) == ACTIVE (verificación on-chain)
     e. Responde: {
          valid: true | false,
          reason: null | "EXPIRED" | "WRONG_LOCATION" | "ALREADY_USED" | ...,
          product_info: { name, collection, serial_number }
        }

7. POS muestra resultado semafórico al operador:
   🟢 VERDE  → Proceder con la entrega
   🔴 ROJO   → No entregar (razón mostrada al operador)

[Si VERDE: operador confirma entrega física y ejecuta burn]

8. POS llama al backend para ejecutar el burn
   POST /functions/v1/burn-claim {
     pass_hash,
     pos_shift_id
   }
   → Edge Function 'burn-claim':
     a. Re-verifica todas las condiciones (idempotente)
     b. Ejecuta dos transacciones Stellar en orden:
        i.  C-03.burn(token_id, pos_id)
        ii. C-05.redeem_pass(pass_hash, pos_id)
     c. Actualiza en Supabase:
        - claim_passes.pass_status = 'USED'
        - tokenized_items.burn_tx_hash = stellar_tx_hash
     d. INSERT pos_shifts_claims_count++ (contador del turno)

9. Indexer detecta eventos ProductBurned + PassRedeemed on-chain
   → Actualiza tokenized_items.token_status = 'BURNED'
   → INSERT claim_redemptions {
        claim_pass_id, tokenized_item_id, pos_shift_id,
        pos_operator_user_id, burn_tx_hash, redeemed_at
      }
   → Supabase Realtime notifica al consumidor: "¡Botella retirada exitosamente!"

10. Cierre de turno POS
    PATCH /pos-shifts/{id} { shift_closed_at: now() }
    → Genera reporte de turno (PDF)
    → Verifica: total_claims_processed == claim_redemptions COUNT para este turno
```

---

## Flujo 6 — Escaneo de QR Público (Visor de Trazabilidad)

```
Actor: Cualquier persona (consumidor, periodista, importador, auditor)
Precondición: Botella física con QR impreso en la etiqueta
Resultado: Vista pública de la cadena de producción verificable en blockchain
```

```
1. Persona escanea el QR de la botella
   → URL: https://api.drinks-on-chain.com/qr/{token_id}
   (o https://api.drinks-on-chain.com/batch/{international_lot_code})

2. Backend devuelve JSON público (sin autenticación requerida):
   GET /public/product/{token_id}
   {
     // Identidad del token
     token_id, serial_number, collection_name,
     token_status: "MINTED" | "BURNED",
     blockchain_tx_mint: "stellar_tx_hash",
     
     // Productor
     producer_name, producer_region, producer_country,
     
     // Trazabilidad del lote
     harvest_year, terroir_name, altitude_masl, grape_variety,
     is_do_certified, bottling_date, international_lot_code,
     packaging_format_cl,
     
     // Análisis de laboratorio (datos públicos)
     actual_alcohol_abv, total_acidity_tartaric_gl,
     total_sulfur_dioxide_mg_l, beverage_type,
     laboratory_name, conforms_to_senasag_standards,
     
     // Verificación blockchain
     batch_anchor_tx: "stellar_tx_hash",
     batch_anchor_timestamp: "ISO 8601",
     stellar_explorer_url: "https://stellar.expert/explorer/..."
   }

3. El consumidor puede verificar el hash on-chain:
   → Stellar Explorer muestra el evento BatchAnchored con el hash
   → Cualquiera puede recalcular SHA-256 con los datos del lote y comparar
```

---

## Resumen de Edge Functions del MVP

| Edge Function | Trigger | Contratos Stellares |
|---|---|---|
| `create-wallet` | Registro de usuario/bodega | — (Dynamic API) |
| `register-producer` | Admin aprueba bodega | C-01 ProducerRegistry |
| `anchor-batch` | Lote liberado por enólogo | C-02 BatchAnchor |
| `payment-callback` | Webhook de plataforma de pagos | — |
| `mint-nft` | Post pago confirmado | C-03 ProductNFT |
| `generate-claim-pass` | Consumidor solicita retiro | C-05 ClaimEscrow |
| `validate-claim` | POS escanea QR | C-05 ClaimEscrow (read) |
| `burn-claim` | POS confirma entrega | C-03 ProductNFT + C-05 ClaimEscrow |
| `sync-stellar-event` | Indexer detecta evento on-chain | — (solo lectura/sync) |
