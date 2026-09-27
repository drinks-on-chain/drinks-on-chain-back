# Alcance MVP — Drinks on Chain

> **Versión:** 1.0  
> **Fecha:** 2026-08-28  
> **Estado:** APROBADO para desarrollo  
> **Stack:** Supabase (PostgreSQL + Auth + Storage + Edge Functions) · Stellar Soroban · Dynamic (wallets)

---

## ¿Qué es Drinks on Chain?

Plataforma **B2B/B2C multi-tenant** para la trazabilidad de producción y tokenización de bebidas (vino, Singani y otros destilados) sobre la blockchain de Stellar.

El sistema permite a bodegas y productores registrar todo su proceso productivo con trazabilidad inmutable, y tokenizar cada botella de un lote certificado como un NFT, el cual el consumidor puede comprar, poseer y reclamar físicamente.

---

## Alcance del MVP (Fase 1)

### ✅ Incluido en esta fase

| Área | Funcionalidad |
|---|---|
| **ERP de Trazabilidad** | Registro de terroir, cosecha, fermentación, tratamientos, crianza/destilación, embotellado |
| **Laboratorio** | Registro de análisis físico-químicos del lote embotellado |
| **Anclaje Blockchain** | Hash de cada lote embotellado anclado en Stellar (C-02 BatchAnchor) |
| **Tokenización** | Creación de colecciones y minting de NFTs por botella (bajo aprobación de Debro) |
| **Wallets** | Wallets invisibles para bodegas (firma de transacciones) y consumidores (posesión de NFT) via Dynamic |
| **Compra** | Flujo de pago via plataforma externa → callback → mint automático |
| **Claim/Retiro** | Generación de QR efímero + validación y burn en POS físico |
| **Registro de bodegas** | Onboarding de productores y sus miembros profesionales |
| **Multi-tenant** | Aislamiento de datos por bodega con RLS en Supabase |
| **Indexer Stellar** | Servicio de sincronización de eventos on-chain → Supabase |

### 🚫 Fuera del MVP (diseñado para escalar)

| Área | Motivo / Fase futura |
|---|---|
| Exportación internacional (VI-1, TTB, SENASAG) | Fase 2 — Esquema DB ya contemplado |
| Mercado secundario (reventa entre usuarios) | Fase 3 |
| Pre-venta de lotes (antes de producir) | Fase 2 — Estructura de BD lista |
| KYC/KYB de usuarios y bodegas | Fase 2 |
| Envío a domicilio / logística | No planificado |
| Facturación electrónica (SIAT Bolivia) | Fase 3 |
| Reportes y analytics BI | Fase 2 |
| Frontend / aplicación web | No aplica — solo backend |
| Comisiones de plataforma | Fase 2 |

---

## Principios de Diseño

### 1. Backend-First
El proyecto entrega exclusivamente:
- **Contratos inteligentes** en Soroban (Rust) sobre Stellar
- **Backend API** via Supabase (PostgREST + Edge Functions)
- **Supabase DB Schema** (migrations en SQL)

No hay frontend en este proyecto. Los consumidores del backend serán apps móviles o web construidas por separado.

### 2. Multi-Tenant
Cada bodega (tenant) tiene sus datos completamente aislados mediante **Row Level Security (RLS)** en Supabase. Un usuario de la bodega A nunca puede ver datos de la bodega B.

### 3. Contratos Genéricos para Cualquier Bebida
Los contratos Stellar NO son específicos de vino o Singani. Operan sobre entidades genéricas (`producer`, `batch`, `product_unit`) con un campo `beverage_type` extensible. Esto permite soportar cualquier bebida alcohólica o alimento trazable en el futuro.

### 4. Escalabilidad para Pre-Venta
La estructura de BD y contratos soporta el flujo de pre-venta (comprar antes de que el lote esté embotellado) aunque no está activo en el MVP. La diferencia es el momento del mint: **hoy → post-compra confirmada**, **futuro → cuando el lote esté listo**.

### 5. Idiomas
El sistema maneja **español e inglés** en:
- Mensajes de error y respuestas de la API
- Enums con labels traducibles (tabla `enum_labels` o `i18n` en Supabase)
- Metadata de tokens NFT (campos `name_es`, `name_en`)

---

## Tecnologías

| Capa | Tecnología | Propósito |
|---|---|---|
| Blockchain | **Stellar + Soroban** | Contratos inteligentes, NFTs, anclaje de hashes |
| Base de datos | **Supabase PostgreSQL** | Datos operacionales, ERP, marketplace |
| Auth | **Supabase Auth** | Autenticación de bodegas y consumidores |
| Wallets | **Dynamic SDK** | Wallets invisibles para bodegas y consumidores |
| Almacenamiento | **Supabase Storage** | PDFs, imágenes, metadata de NFTs |
| API | **Supabase PostgREST + Edge Functions** | Endpoints REST y lógica de negocio |
| Tiempo real | **Supabase Realtime** | Notificaciones de estado (fermentación, mints) |
| Indexer | **Servicio Node.js / Deno** | Sincroniza eventos Stellar → Supabase |
| Pagos | **Plataforma externa (TBD)** | Procesamiento de pagos fiat con callback |

---

## Flujos Principales del MVP

```
[TRAZABILIDAD ERP]
Terroir → Cosecha → Fermentación → Crianza/Destilación → Embotellado
→ Análisis Lab → Bodega aprueba → C-02 BatchAnchor (hash on-chain)

[TOKENIZACIÓN]
Debro aprueba lote → Crea colección → Publica en marketplace

[COMPRA]
Consumidor selecciona botella → Plataforma de pago genera cobro (con código de orden)
→ Consumidor paga → Callback al backend → Backend valida → C-03 ProductNFT.mint()
→ NFT en wallet invisible del consumidor (Dynamic)

[RETIRO FÍSICO]
Consumidor genera Claim Pass (QR efímero) → C-05 ClaimEscrow.generate()
→ Presenta en POS → POS valida → C-03.burn() + C-05.redeem()
→ Indexer detecta evento Burn → Supabase registra CLAIM_REDEMPTIONS
```

---

## Dudas Resueltas

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | Flujo de pago | Plataforma externa + callback → mint |
| 2 | Wallets bodegas | Sí, Dynamic — para firma de transacciones de trazabilidad |
| 3 | Quién firma on-chain | Backend como relayer (firma en nombre del usuario/bodega) |
| 4 | ¿Una app o varias? | Una sola app multi-tenant, solo backend |
| 5 | QR en botella | Estático (impreso en etiqueta) |
| 6 | ¿Cuándo se mintea? | Al confirmar la compra (lazy minting) |
| 7 | Mercado secundario | Diseñar para ello, no activar en MVP |
| 8 | Stock físico | En bodega del productor, solo retiro en punto físico |
| 9 | Exportación | Fuera del MVP, schema DB ya preparado |
| 10-13 | Fees, envíos, KYC, facturación | Fuera del MVP |
| 14 | Multi-idioma | Español + Inglés en API/metadata |
| 16 | Indexer Stellar | Documentar y diseñar |
