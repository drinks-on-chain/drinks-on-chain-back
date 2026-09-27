# Contratos Inteligentes Stellar — Drinks on Chain

> **Stack:** Soroban (Rust) sobre Stellar Testnet → Mainnet  
> **Principio de diseño:** Contratos **genéricos** — no específicos de vino/Singani. Operan sobre `producer`, `batch` y `product_unit` extensibles a cualquier bebida o producto trazable.  
> **Rol del backend:** El backend de Supabase actúa como **relayer** — firma y envía transacciones en nombre de bodegas y consumidores, que poseen wallets invisibles (Dynamic).

---

## Filosofía de los Contratos

Los contratos de Stellar cumplen una única responsabilidad: **propiedad e inmutabilidad**.

```
LO QUE VIVE ON-CHAIN           LO QUE VIVE OFF-CHAIN
───────────────────────────    ───────────────────────────────────────
✅ Hashes de lotes             ✅ Datos del ERP (lotes, análisis, etc.)
✅ Ownership de NFTs           ✅ Lógica de negocio compleja
✅ Registro de productores     ✅ Flujo de pagos (plataforma externa)
✅ Claim passes (hashes)       ✅ Generación de documentos PDF
✅ Eventos de mint/burn        ✅ Reportes y auditoría operacional
```

El backend es el único firmante de transacciones (patrón relayer). Las wallets de Dynamic son los propietarios on-chain de los tokens.

---

## Contratos del MVP (Fase 1)

| ID | Contrato | Estado en MVP | Propósito |
|---|---|---|---|
| C-01 | `ProducerRegistry` | ✅ MVP | Registro inmutable de productores certificados |
| C-02 | `BatchAnchor` | ✅ MVP | Anclaje de hashes de lotes en blockchain |
| C-03 | `ProductNFT` | ✅ MVP | NFT por unidad de producto (botella, lata, etc.) |
| C-04 | `Marketplace` | 🔜 Fase 2 | Compra-venta on-chain con USDC |
| C-05 | `ClaimEscrow` | ✅ MVP | Generación y validación de claim passes |
| C-06 | `Governance` | 🔜 Fase 3 | Multisig admin para operaciones críticas |

---

## C-01 — ProducerRegistry

### Propósito
Registro inmutable de productores (bodegas, destilerías, etc.) autorizados en la plataforma.  
Es el **guardián de confianza**: todos los demás contratos verifican aquí si un productor puede operar.

> **Genérico:** No es un registro de "bodegas de vino", es un registro de cualquier **productor de bebidas** certificado por Debro Solutions.

### Funciones

| Función | Caller | Descripción |
|---|---|---|
| `register_producer(producer_id, stellar_address, metadata_hash)` | Admin (Debro) | Registra un productor con hash de su metadata en Supabase |
| `revoke_producer(producer_id)` | Admin (Debro) | Revoca la certificación |
| `is_active(producer_id) → bool` | Público | Verifica si el productor está activo |
| `get_producer(producer_id) → ProducerRecord` | Público | Devuelve el registro del productor |
| `update_metadata_hash(producer_id, new_hash)` | Admin | Actualiza el hash cuando cambian datos del productor |
| `transfer_admin(new_admin)` | Admin | Traspasa el control administrativo |

### Storage
```rust
struct ProducerRecord {
    stellar_address: Address,    // Wallet Stellar del productor (Dynamic)
    metadata_hash: BytesN<32>,   // SHA-256 del JSON de 'wineries' en Supabase
    is_active: bool,
    registered_at: u64,
    registered_by: Address,      // Admin de Debro que aprobó
}
// Map<Symbol (producer_id), ProducerRecord>
```

### Eventos
- `ProducerRegistered { producer_id, stellar_address, metadata_hash }`
- `ProducerRevoked { producer_id }`
- `ProducerMetadataUpdated { producer_id, new_hash }`

---

## C-02 — BatchAnchor

### Propósito
Ancla el **hash SHA-256** de un lote de producción certificado en la blockchain.  
No almacena datos (eso está en Supabase). Solo la huella criptográfica que permite auditar que los datos no fueron alterados.

> **Genérico:** Un "batch" es cualquier lote de cualquier producto. El campo `batch_type` identifica si es un lote de vino, Singani, cerveza, etc.

### Funciones

| Función | Caller | Descripción |
|---|---|---|
| `anchor_batch(batch_id, data_hash, producer_id, batch_type)` | Backend (relayer) | Ancla el hash del lote embotellado + análisis de lab |
| `anchor_document(doc_id, doc_hash, doc_type)` | Backend (relayer) | Ancla hash de documentos oficiales (exportación, etc.) |
| `get_batch_anchor(batch_id) → BatchRecord` | Público | Retorna el hash y timestamp del anclaje |
| `get_document_anchor(doc_id) → DocRecord` | Público | Verifica integridad de un documento |
| `verify_batch(batch_id, hash_to_verify) → bool` | Público | Verifica si el hash coincide con el anclado |

### Storage
```rust
struct BatchRecord {
    producer_id: Symbol,
    data_hash: BytesN<32>,       // SHA-256(JSON de BOTTLING_BATCHES + LAB_ANALYSES)
    batch_type: Symbol,          // "WINE", "SINGANI", "BEER", etc. — extensible
    anchored_at: u64,
    anchored_by: Address,        // Dirección del relayer (backend)
}

struct DocRecord {
    doc_type: Symbol,            // "EU_VI1", "SENASAG_CERT", "PACKING_LIST", etc.
    document_hash: BytesN<32>,
    anchored_at: u64,
}
```

### Eventos
- `BatchAnchored { batch_id, producer_id, batch_type, data_hash }`
- `DocumentAnchored { doc_id, doc_type, doc_hash }`

### Cuándo se invoca
```
Supabase DB Trigger / Edge Function:
  CUANDO: enólogo marca bottling_batch como RELEASED + lab analysis conformes
  HACE: backend calcula SHA-256 del JSON del lote → llama C-02.anchor_batch()
  GUARDA: tx_hash en bottling_batches.blockchain_anchor_tx_hash
```

---

## C-03 — ProductNFT

### Propósito
Token no fungible que representa **una unidad física de producto** (una botella, una lata, etc.).  
Es el contrato central del ecosistema de tokenización.

> **Genérico:** No es un "BottleNFT". Es un `ProductNFT` que puede representar cualquier unidad física rastreable. El tipo de producto se especifica en el metadata.

### Funciones

| Función | Caller | Descripción |
|---|---|---|
| `mint(to, token_id, collection_id, metadata_hash)` | Backend (relayer) | Mintea un NFT al comprador tras confirmar pago |
| `transfer(from, to, token_id)` | Owner / Backend | Transfiere ownership (para mercado secundario futuro) |
| `burn(token_id, pos_id)` | Backend (relayer) | Quema el NFT al retirar físicamente el producto |
| `owner_of(token_id) → Address` | Público | Consulta propietario actual |
| `get_token(token_id) → TokenRecord` | Público | Metadata hash + estado del token |
| `is_burned(token_id) → bool` | Público | Verifica si la unidad fue retirada |
| `collection_stats(collection_id) → Stats` | Público | Total minted, burned, disponibles |
| `batch_mint(tokens: Vec<MintParams>)` | Backend (relayer) | Mint en batch (múltiples tokens en una tx) |

### Storage
```rust
struct TokenRecord {
    collection_id: Symbol,
    owner: Address,              // Wallet Dynamic del comprador
    metadata_hash: BytesN<32>,  // SHA-256 del JSON de 'tokenized_items' en Supabase
    product_type: Symbol,        // "WINE", "SINGANI", "BEER" — extensible
    minted_at: u64,
    burned_at: Option<u64>,
    is_burned: bool,
    pos_id: Option<Symbol>,      // POS donde fue quemado
}
```

### Eventos
- `ProductMinted { token_id, collection_id, owner, product_type }`
- `ProductTransferred { token_id, from, to }`
- `ProductBurned { token_id, owner, pos_id, timestamp }`

### Flujo de Mint post-pago
```
1. Plataforma de pago genera cobro con {order_code} que incluye {collection_id, user_id, qty}
2. Consumidor paga
3. Plataforma llama callback al backend de Supabase
4. Edge Function valida el callback (firma/secret del proveedor de pagos)
5. Edge Function consulta la orden en BD → obtiene token_ids reservados
6. Backend (relayer) firma y envía tx → C-03.mint(user_wallet, token_id, ...)
7. Indexer detecta evento ProductMinted → actualiza tokenized_items.token_status = 'MINTED'
8. Supabase Realtime notifica al cliente (si está conectado)
```

### Sobre batch_mint
Para colecciones grandes, en lugar de N transacciones individuales, el backend puede mintear múltiples tokens en una sola transacción. Esto reduce costos y latencia.

---

## C-05 — ClaimEscrow

### Propósito
Gestiona la generación y validación criptográfica de **Claim Passes** (pases de retiro).  
Garantiza que un NFT solo pueda retirarse físicamente **una vez**, desde un **POS autorizado**.

### Funciones

| Función | Caller | Descripción |
|---|---|---|
| `register_pos(pos_id, pos_stellar_address, location_hash)` | Admin (Debro) | Registra un terminal POS como autorizado |
| `deactivate_pos(pos_id)` | Admin (Debro) | Desactiva un POS |
| `generate_pass(token_id, owner, pass_hash, expires_at)` | Backend (relayer) | Ancla el hash de un claim pass en la blockchain |
| `redeem_pass(pass_hash, pos_id)` | Backend (relayer) | Valida y marca como usado; triggerea el burn en C-03 |
| `revoke_pass(pass_hash, token_id)` | Backend (relayer) | Cancela un pass activo |
| `is_valid_pos(pos_id) → bool` | Público | Verifica si un POS está activo |
| `get_pass_status(pass_hash) → PassStatus` | Público | Estado del pass: ACTIVE / USED / EXPIRED / REVOKED |

### Storage
```rust
struct PassRecord {
    token_id: Symbol,
    owner: Address,
    pass_hash: BytesN<32>,       // SHA-256(token_id + user_id + nonce + expires_at)
    expires_at: u64,
    status: PassStatus,          // ACTIVE, USED, EXPIRED, REVOKED
    redeemed_by_pos: Option<Symbol>,
    redeemed_at: Option<u64>,
}

struct PosRecord {
    stellar_address: Address,
    location_hash: BytesN<32>,   // Hash del JSON de 'pickup_locations' en Supabase
    is_active: bool,
    registered_at: u64,
}
```

### Eventos
- `PassGenerated { token_id, pass_hash, expires_at }`
- `PassRedeemed { token_id, pass_hash, pos_id, timestamp }`
- `PassRevoked { token_id, pass_hash }`
- `PosRegistered { pos_id, stellar_address }`

### Flujo de Claim
```
1. Consumidor solicita retiro en la app → backend genera:
   pass_hash = SHA-256(token_id + user_id + nonce + expires_at)
   
2. Backend llama C-05.generate_pass(token_id, owner_wallet, pass_hash, expires_at)

3. Backend genera QR con el payload: {pass_hash, token_id, expires_at}
   QR es estático dentro de su ventana de tiempo (se regenera si expira)

4. Consumidor presenta QR en POS físico

5. POS app escanea QR → llama a API backend con {pass_hash, pos_id}

6. Backend verifica:
   a. C-05.get_pass_status(pass_hash) == ACTIVE
   b. Timestamp actual < expires_at
   c. C-05.is_valid_pos(pos_id) == true
   d. tokenized_items.token_status == 'MINTED' (en Supabase)

7. Si todo válido → backend ejecuta dos txs en Stellar:
   a. C-03.burn(token_id, pos_id)
   b. C-05.redeem_pass(pass_hash, pos_id)

8. Indexer detecta eventos ProductBurned + PassRedeemed
   → Supabase: tokenized_items.token_status = 'BURNED'
   → Supabase: claim_redemptions INSERT

9. Backend responde al POS con ✅ VERDE (aprobado para entrega)
```

---

## C-04 — Marketplace *(Fase 2)*

> No se implementa en el MVP. El pago se gestiona via plataforma de pagos externa.  
> En Fase 2, este contrato habilitaría pagos nativos en USDC Stellar.

### Funciones previstas
- `list_collection(collection_id, price_usdc, supply, producer_id)`
- `buy(collection_id, quantity)` — transfiere USDC y triggerea mint
- `withdraw_proceeds(collection_id)` — bodega retira sus fondos

---

## C-06 — Governance *(Fase 3)*

> Multisig admin para operaciones críticas. Previene que una sola clave privada de Debro sea punto de falla.

### Funciones previstas
- `propose(action, params)` / `approve(proposal_id)` / `execute(proposal_id)`
- Quorum: 2 de 3 firmantes (CEO, CTO, Legal de Debro)

---

## Dependencias entre Contratos

```
C-06 Governance (Fase 3)
    └─ administra ──────────────────→ C-01 ProducerRegistry
                                           └─ valida autorización ──→ C-02 BatchAnchor
                                           └─ valida autorización ──→ C-03 ProductNFT
                                                                           ↑ mint / burn
                                      C-05 ClaimEscrow
                                           └─ triggerea ───────────→ C-03.burn()
                                      C-04 Marketplace (Fase 2)
                                           └─ triggerea ───────────→ C-03.mint()

[MVP: Backend (relayer) es el firmante de todas las txs hacia C-02, C-03, C-05]
```

---

## Patrón Relayer

Dado que los usuarios tienen wallets invisibles (Dynamic), el **backend actúa como relayer**:

```
Usuario/Bodega → API Supabase Edge Function
                      ↓
               Backend construye la transacción Stellar
                      ↓
               Backend firma con su clave privada de relayer
               (una clave dedicada, separada de las wallets de usuarios)
                      ↓
               Soroban RPC → Stellar Network
                      ↓
               Respuesta: tx_hash → guardado en Supabase
```

**Claves privadas del relayer:**
- Almacenadas en variables de entorno de Supabase (Vault de secretos)
- Nunca expuestas en código fuente
- Clave separada por entorno (testnet / mainnet)

---

## Plan de Despliegue

| Fase | Contratos | Red | Trigger |
|---|---|---|---|
| **MVP Fase 1** | C-01, C-02, C-03, C-05 | Testnet | Launch del MVP |
| **Fase 2** | + C-04 Marketplace | Testnet → Mainnet | Activar pagos cripto |
| **Fase 3** | + C-06 Governance | Mainnet | Escala operacional |

---

## Costos Estimados (Soroban / Stellar)

| Operación | Costo estimado |
|---|---|
| Deploy de contrato | ~0.01 XLM |
| Anchor de batch | ~0.001 XLM |
| Mint NFT individual | ~0.002–0.005 XLM |
| Batch mint (10 tokens) | ~0.01–0.02 XLM |
| Burn NFT | ~0.001 XLM |
| Generate/Redeem pass | ~0.001 XLM c/u |

> Para 1,000 botellas en MVP: costo total estimado < **15 XLM** (~$3 USD).
