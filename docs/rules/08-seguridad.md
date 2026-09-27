# Reglas y Estándares de Seguridad — Drinks on Chain

> Este documento compila las directrices, estándares y controles de seguridad obligatorios para el backend en NestJS, la persistencia en PostgreSQL y la integración con la blockchain de Stellar Soroban.

---

## 1. Seguridad Blockchain y Gestión de Claves Criptográficas

### A. Custodia de la Clave Privada del Relayer (`STELLAR_RELAYER_SECRET_KEY`)
- La clave privada del relayer (Ed25519 Secret Seed, comenzando por `S...`) tiene permisos para firmar transacciones de minteo, quema y anclaje on-chain.
- **Regla Inmutable:** La clave privada **nunca** debe almacenarse en el código fuente, repositorios Git, logs ni exponerse al cliente/frontend.
- **Acceso Restringido:** Solo el servicio `StellarService` tiene acceso a esta variable inyectada desde `ConfigService`.

### B. Prevención de Ataques de Replay en Pases QR de Claim
- Cada pase QR generado contiene un `nonce` criptográfico aleatorio y un timestamp de expiración (`expires_at`).
- El hash del pase (`pass_hash = SHA-256(payload)`) se ancla en el contrato `C-05 ClaimEscrow`.
- Un pase solo puede ser redimido una única vez: el contrato C-05 y la base de datos cambian su estado atómicamente a `USED`/`BURNED`, invalidando cualquier intento posterior de reutilización o captura de pantalla.

### C. Idempotencia en Transacciones Blockchain
- Antes de enviar una transacción de minteo o anclaje, el backend verifica si la entidad ya cuenta con un `tx_hash` registrado para evitar doble emisión o consumo innecesario de comisiones (fees de Stellar).

### D. Idempotencia en la API (`Idempotency-Key`) — ajustado por A-33 (27-09-2026)
- Los clientes envían `Idempotency-Key: <UUID>` en las operaciones que no deben repetirse (cabecera permitida en CORS). `@Idempotent()` guarda en Redis, 24 h, la huella del cuerpo y la respuesta por persona + ruta + clave: un reintento devuelve la misma respuesta sin repetir la operación; otro cuerpo con la misma clave → 409 `IDEMPOTENCY_KEY_REUSED`; dos peticiones a la vez → 409 `IDEMPOTENCY_IN_PROGRESS`.
- Obligatoria (`@Idempotent({ required: true })`) desde la Ola 3 en pedidos, pases, canjes, aprobaciones de tokenización y reembolsos; hoy se aplica a las altas del ERP. Complementa, no sustituye, las restricciones `UNIQUE` y las comprobaciones de estado de la base.

---

## 2. Aislamiento Multi-Tenant (Tenant Boundary Isolation)

### A. Filtrado Obligatorio por `wineryId`
- Todo `Service` y `Repository` que maneje entidades B2B (terroirs, cosechas, tanques, lotes, análisis) **debe** incluir `wineryId` en el `WHERE` de la consulta.
- Los decoradores `@TenantId()` y el guardia `TenantGuard` aseguran que el contexto del tenant provenga exclusivamente del token JWT firmado.

### B. Prevención de Fugas de Existencia de Recursos (Security by Obscurity)
- Si un usuario intenta consultar o modificar un recurso que pertenece a otra bodega, la API **debe responder con HTTP 404 (Not Found)** en lugar de HTTP 403 (Forbidden).
- **Razón:** Responder 403 confirma a un atacante que el recurso existe. Responder 404 oculta por completo la existencia de datos de otros tenants.

```typescript
// src/shared/helpers/tenant-resource.helper.ts
export function assertBelongsToTenant<T extends { wineryId: string }>(
  resource: T | null,
  resourceName: string,
  id: string,
  tenantId: string,
): asserts resource is T {
  if (!resource || resource.wineryId !== tenantId) {
    // Siempre 404 para proteger la privacidad multi-tenant
    throw new ResourceNotFoundException(resourceName, id);
  }
}
```

---

## 3. Seguridad en Pasarela de Pagos y Webhooks

### A. Verificación Criptográfica contra Timing Attacks (HMAC)
- Todo webhook entrante en `POST /v1/webhooks/payments` debe ser validado con su firma criptográfica.
- La comparación de hashes **debe** utilizar `crypto.timingSafeEqual` para prevenir ataques de temporización (*timing attacks*).

```typescript
import * as crypto from 'crypto';

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  try {
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSig, 'hex');

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
```

### B. Idempotencia en Pagos (Prevención de Doble-Minteo)
- El campo `payment_gateway_reference` (`charge_id`) tiene una restricción `UNIQUE` en la base de datos.
- Si el banco reenvía el webhook por reintentos de red, el sistema detecta que el cobro ya fue procesado y responde HTTP 200 inmediatamente sin volver a encolar el minteo.

---

## 4. Seguridad en Terminales POS (Puntos de Canje)

### A. Autenticación de Doble Factor Físico
- El operador debe estar autenticado con su usuario individual (`role = POS_OPERATOR`).
- Adicionalmente, el turno del POS requiere validar el `pin_hash` de la sucursal física almacenado con **bcrypt** (cost factor 12).

### B. Validación de Ubicación y Estado
- Un pase QR generado para la `pickup_location_id = A` es rechazado de inmediato si se escanea en la `pickup_location_id = B`.
- El POS solo puede quemar tokens cuyo estado actual sea estrictamente `MINTED`.

### C. Confirmación Explícita ("Swipe to Confirm")
- La interfaz del POS requiere una acción física deliberada del operador antes de invocar `/v1/claims/burn`, evitando la quema accidental de NFTs por lecturas no intencionadas de la cámara.

---

## 5. Seguridad de la API (OWASP Top 10 & Hardening)

### A. Headers de Seguridad con `Helmet`
Se configuran cabeceras defensivas para mitigar ataques XSS, Clickjacking y MIME Sniffing:
- `Content-Security-Policy`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security` (HSTS)
- `X-XSS-Protection`

### B. Rate Limiting / Throttling con `@nestjs/throttler`
Para mitigar ataques de fuerza bruta y denegación de servicio (DoS):
- **Endpoints de Auth (`/v1/auth/*`):** Máximo 5 intentos por minuto por IP.
- **Endpoints de Webhooks (`/v1/webhooks/*`):** Máximo 30 peticiones por minuto.
- **Endpoints de POS (`/v1/claims/validate`):** Máximo 60 peticiones por minuto por terminal.
- **Endpoints Generales:** Máximo 120 peticiones por minuto por IP.

### C. Prevención de Inyección SQL
- Todas las consultas a la base de datos se ejecutan a través de **Prisma ORM**, garantizando queries 100% parametrizadas.
- Queda estrictamente prohibido concatenar strings en queries crudas (`$queryRawUnsafe`). Si se requiere SQL crudo, usar siempre `$queryRaw` con tagged template literals.

### D. Sanitización y Validación de Entrada
- Todo endpoint con body o query params debe validar contra un DTO con `class-validator`.
- Configuración global estricta en `main.ts`:
  - `whitelist: true` (descarta propiedades no declaradas en el DTO).
  - `forbidNonWhitelisted: true` (rechaza con HTTP 422 `VALIDATION_ERROR` y un detalle por campo no declarado; ajustado por A-33, antes 400).
  - `transform: true` (convierte tipos primitivos de forma segura).

### E. CORS Restrictivo
- No usar wildcard `*` en entornos de producción o staging.
- Whitelist explícita de dominios frontend autorizados desde `CORS_ALLOWED_ORIGINS`.

---

## 6. Manejo de Secretos y Auditoría

1. **Validación Fail-Fast al Arrancar:** Si falta un secreto o variable crítica en el `.env`, la aplicación no inicia.
2. **Cero Fuga en Logs:** Todo objeto antes de registrarse en logs pasa por `sanitizeLogData`, enmascarando claves privadas de Stellar (`S...`), contraseñas, PINs y datos bancarios.
3. **Registro Inmutable de Auditoría:** Cambios críticos de estado (liberación de lotes, transferencias, revocaciones de bodegas) se registran en la tabla `audit_logs` con `old_values`, `new_values`, `user_id`, `ip_address` y timestamp UTC.
