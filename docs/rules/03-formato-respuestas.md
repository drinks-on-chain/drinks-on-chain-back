# Formato de Respuestas de la API — Drinks on Chain

> Todos los endpoints del sistema devuelven respuestas en el mismo formato estructurado.  
> Implementado via `ResponseTransformInterceptor` global.
>
> **Ajustado por A-33 (27-09-2026)**: listas con `limit`/`offset` (no `page`), validación en **422** con `details: [{ field, message }]`, cabecera `Idempotency-Key` y 429 con `Retry-After`. Fuente: `plan/contratos/o0-sesiones-y-estandares.md` §1–§3. El contrato publicado es `openapi.json` en la raíz del repo.

---

## Estructura Base

### Respuesta exitosa (2xx)
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-08-28T21:00:00.000Z",
  "path": "/v1/harvest-batches/abc-123",
  "data": { ... }
}
```

### Respuesta de lista con paginación (ajustado por A-33)
Toda colección devuelve una página:
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-08-28T21:00:00.000Z",
  "path": "/v1/harvest-batches?limit=20&offset=40",
  "data": {
    "items": [ ... ],
    "total": 47,
    "limit": 20,
    "offset": 40
  }
}
```

### Respuesta de error (4xx / 5xx)
```json
{
  "success": false,
  "statusCode": 404,
  "timestamp": "2026-08-28T21:00:00.000Z",
  "path": "/v1/harvest-batches/abc-123",
  "error": {
    "code": "HARVEST_BATCH_NOT_FOUND",
    "message": "Harvest batch abc-123 not found",
    "details": null
  }
}
```

### Respuesta de error de validación (422, ajustado por A-33)
`details` es **siempre** una lista de `{ field, message }` o `null`. `field` usa notación de puntos en los anidados (`items.0.quantity`) y es `null` si el error no es de un campo. Un detalle por regla incumplida.
```json
{
  "success": false,
  "statusCode": 422,
  "timestamp": "2026-08-28T21:00:00.000Z",
  "path": "/v1/harvest-batches",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      { "field": "brixDegrees", "message": "brixDegrees must be a positive number" },
      { "field": "terroirId", "message": "terroirId must be a UUID" }
    ]
  }
}
```

### Errores de reglas de la trazabilidad (Ola 2, contrato O2 §0 y §13)
Estado del recurso → **409**; regla de negocio incumplida → **422**; escritura de la plataforma en la trazabilidad → **403 `TRC_PLATFORM_READ_ONLY`**. `details` amplía la forma anterior de manera **aditiva** con el código de cada violación, la regla de la instantánea del lote, lo exigido, lo registrado y datos para que la UI explique cuándo se podrá hacer. El `code` de la respuesta es el de la primera violación; `details` las trae todas.
```json
{
  "success": false,
  "statusCode": 422,
  "error": {
    "code": "TRC_LOCK_NOT_RELEASED",
    "message": "Reposo mínimo de 180 días: disponible el 2026-10-13 (faltan 16 días)",
    "details": [
      {
        "field": "bottlingDate",
        "message": "Reposo mínimo de 180 días: disponible el 2026-10-13 (faltan 16 días)",
        "code": "TRC_LOCK_NOT_RELEASED",
        "rule": "trazabilidad.singani.reposoMinimoDias",
        "expected": "2026-10-13",
        "actual": "2026-09-27",
        "meta": { "sourceId": "…", "kind": "REST", "unlockDate": "2026-10-13", "daysRemaining": 16 }
      }
    ]
  }
}
```
Una ruta del contrato publicada sin lógica todavía responde **501 `NOT_IMPLEMENTED`** con `details[0].meta.step` (paso de la Etapa 2 que la trae).

---

## Implementación

| Pieza | Archivo |
|---|---|
| Interfaces (`ApiSuccessResponse`, `ApiErrorResponse`, `ErrorDetail`, `Paginated<T>`) | `src/shared/interfaces/api-response.interface.ts` |
| Envoltorio de éxito | `src/shared/interceptors/response-transform.interceptor.ts` |
| Filtro de errores (normaliza `details`, 429 con `Retry-After`) | `src/shared/filters/global-exception.filter.ts` |
| `ValidationPipe` global → 422 con `details` por campo | `src/shared/pipes/app-validation.pipe.ts`, `src/shared/exceptions/validation.exception.ts` |
| Catálogo de códigos | `src/shared/exceptions/error-codes.ts` |
| Consulta paginada y página | `src/shared/dto/pagination-query.dto.ts` |
| `@ApiPaginatedResponse(Dto)` (esquema de la página en OpenAPI) | `src/shared/decorators/api-paginated-response.decorator.ts` |
| `@Idempotent()` e interceptor | `src/shared/idempotency/` |
| Configuración común de la app (la usan `main.ts`, las e2e y el OpenAPI) | `src/app.setup.ts` |

### Interfaz de respuesta
```typescript
// src/shared/interfaces/api-response.interface.ts
export interface ErrorDetail {
  field: string | null; // notación de puntos: items.0.quantity
  message: string;
}

export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  timestamp: string;
  path: string;
  error: { code: string; message: string; details: ErrorDetail[] | null };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
```

### Validación global (422)
```typescript
// src/shared/pipes/app-validation.pipe.ts — lo aplica configureApp()
new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors) =>
    new ValidationException(flattenValidationErrors(errors)), // 422 VALIDATION_ERROR
});
```

Cuando una comprobación de un campo depende de otro y se hace en el servicio, se lanza igual con el campo: `throw ValidationException.forField('grossWeightKg', 'El peso bruto debe ser…')`.

---

## Códigos de Error del Dominio

> Los códigos de error son `UPPER_SNAKE_CASE` y siempre tienen prefijo del dominio.  
> Permiten al cliente identificar el tipo de error sin parsear el mensaje.

### Idempotencia (A-33)
| Código | HTTP | Descripción |
|---|---|---|
| `IDEMPOTENCY_KEY_INVALID` | 422 | `Idempotency-Key` no es un UUID (`details[0].field = "Idempotency-Key"`) |
| `IDEMPOTENCY_KEY_REQUIRED` | 422 | La operación exige la cabecera (catálogo, desde la Ola 3) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Misma clave con otro cuerpo |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | Otra petición con la misma clave aún se procesa |
| `IDEMPOTENCY_STORE_UNAVAILABLE` | 503 | Redis no responde; la operación no se ejecuta |

### Autenticación y sesión — ajustado por A-33 (sesiones y membresías, `docs/arquitectura/identidad.md`)
| Código | HTTP | Descripción |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Email o contraseña incorrectos (o cuenta bloqueada: no se distingue) |
| `AUTH_TOKEN_EXPIRED` | 401 | Acceso caducado (15 min): renovar |
| `AUTH_TOKEN_INVALID` | 401 | Acceso ausente, inválido o de 0.1 (sin sesión) |
| `AUTH_REFRESH_INVALID` | 401 | Refresco ausente o que no pertenece a la sesión |
| `AUTH_REFRESH_REUSED` | 401 | Refresco ya rotado presentado otra vez: la sesión se revoca |
| `AUTH_SESSION_REVOKED` | 401 | Sesión revocada, o persona o membresía activa bloqueada |
| `AUTH_SESSION_EXPIRED` | 401 | Sesión caducada (7 días personal, 30 consumidores) |
| `AUTH_TOO_MANY_ATTEMPTS` | 429 | Bloqueo progresivo del login, con `Retry-After` |
| `AUTH_INSUFFICIENT_PERMISSIONS` | 403 | Audiencia, tipo de organización activa o rol insuficientes |

### Cuenta, segundo factor e invitaciones (contrato O1 §1–§2)
| Código | HTTP | Descripción |
|---|---|---|
| `AUTH_WEAK_PASSWORD` | 422 | Contraseña nueva corta (< 10) o común; un detalle por problema en el campo |
| `AUTH_INVALID_CURRENT_PASSWORD` | 422 | `POST /users/me/password` con la contraseña actual incorrecta |
| `AUTH_RESET_TOKEN_INVALID` | 422 | Enlace de recuperación desconocido, usado o caducado |
| `AUTH_EMAIL_TOKEN_INVALID` | 422 | Enlace de verificación del correo desconocido, usado o caducado |
| `AUTH_MFA_REQUIRED` | 403 | `switch-organization` a la plataforma sin segundo factor en la sesión |
| `AUTH_MFA_TOKEN_INVALID` | 401 | Reto de segundo factor (`mfaToken`) desconocido, usado o caducado |
| `AUTH_MFA_INVALID_CODE` | 401 | Código TOTP o de recuperación incorrecto (5 seguidos → 429) |
| `AUTH_MFA_NOT_ENROLLED` / `AUTH_MFA_ALREADY_ENROLLED` / `AUTH_MFA_ENROLLMENT_NOT_STARTED` | 409 | Paso del segundo factor que no corresponde |
| `AUTH_LOGIN_REQUIRED` | 401 | Aceptar una invitación de una cuenta que existe sin su sesión |
| `CAPTCHA_INVALID` | 422 | Captcha (Turnstile) rechazado, en `captchaToken` |
| `CAPTCHA_UNAVAILABLE` | 503 | No se pudo comprobar el captcha con Cloudflare |
| `USER_NOT_FOUND` | 404 | Persona inexistente (acciones de la plataforma) |
| `INVITATION_NOT_FOUND` | 404 | Token o id desconocido, o de otra organización |
| `INVITATION_EXPIRED` | 422 | Invitación caducada: reenviarla |
| `INVITATION_NOT_PENDING` | 409 | Aceptada o anulada |
| `INVITATION_ALREADY_PENDING` | 409 | Ya hay una pendiente para ese correo en la organización |
| `INVITATION_EMAIL_MISMATCH` | 403 | La sesión es de otra persona |

### Organizaciones y membresías
| Código | HTTP | Descripción |
|---|---|---|
| `ORG_NOT_FOUND` | 404 | Sin membresía en esa organización, o bodega inexistente en `?wineryId=` |
| `ORG_MEMBERSHIP_BLOCKED` | 403 | Cambiar a una organización donde la membresía está bloqueada |
| `ORG_REVOKED` | 403 | Cambiar a una organización revocada |
| `ORG_NOT_ACTIVE` | 403 | ERP con la bodega activa no `ACTIVE` (SE-05; `details[0].message` = estado; desde la Ola 1) |
| `ORG_BLOCKED_BY_PLATFORM` | 403 | El dueño intenta reactivar una membresía que bloqueó la plataforma |
| `ORG_ALREADY_MEMBER` | 409 | La persona ya es miembro (activo o bloqueado) |
| `ORG_OWNER_ROLE_RESERVED` | 403 | El rol de dueño solo se asigna en el alta o la transferencia |
| `ORG_MEMBER_LIMIT_REACHED` | 422 | Límite de colaboradores (activos + invitaciones pendientes), en `email` |
| `ORG_CANNOT_MODIFY_SELF` | 403 | Cambiar, bloquear o degradar la propia membresía o cuenta |
| `PLATFORM_SUPERADMIN_PROTECTED` | 403 | El superusuario no se bloquea ni se degrada |

Un recurso de otra bodega sigue respondiendo **404** (`NOT_FOUND`), nunca 403.

### Configuración y bitácora (contrato O1 §6–§7)
| Código | HTTP | Descripción |
|---|---|---|
| `SETTING_NOT_FOUND` | 404 | El parámetro no existe en el catálogo |
| `SETTING_LEVEL_NOT_ALLOWED` | 422 | Ajuste por bodega en un parámetro solo general, o estándar en uno solo por bodega |
| `SETTING_BELOW_LEGAL_MINIMUM` | 422 | Valor más laxo que el mínimo legal sin excepción autorizada (A-31) |
| `AUDIT_EXPORT_TOO_LARGE` | 422 | La exportación CSV de la bitácora supera 50 000 filas |

Motivo ausente en una acción del back office sobre terceros (`@RequiresReason()`, AUD-05): 422 `VALIDATION_ERROR` con `details[{ field: 'reason' }]`.

### Bodegas
| Código | HTTP | Descripción |
|---|---|---|

### ERP — Cosechas
| Código | HTTP | Descripción |
|---|---|---|
| `HARVEST_BATCH_NOT_FOUND` | 404 | |
| `HARVEST_BATCH_NOT_APPROVED` | 422 | El lote no tiene aprobación fitosanitaria |
| `HARVEST_BATCH_CODE_DUPLICATE` | 409 | Código de lote ya existe |

### ERP — Fermentación
| Código | HTTP | Descripción |
|---|---|---|
| `FERMENTATION_TANK_NOT_FOUND` | 404 | |
| `FERMENTATION_TANK_ALREADY_TRANSFERRED` | 409 | La cuba ya pasó a un lote de crianza |
| `TRACEABILITY_STRATEGY_NOT_FOUND` | 422 | No hay estrategia de trazabilidad para el tipo de bebida |
| `FERMENTATION_TANK_WRONG_STATUS` | 422 | Operación no válida en el estado actual |
| `FERMENTATION_TANK_DESTINATION_LOCKED` | 422 | El destino ya fue definido y no puede cambiarse |

### ERP — Trazabilidad confiable (Ola 2, contrato O2 §13; `docs/arquitectura/trazabilidad.md`)
| Código | HTTP | Descripción |
|---|---|---|
| `TRC_LOT_NOT_FOUND` | 404 | Lote inexistente o de otra bodega |
| `TRC_INVALID_STAGE` | 409 | Acción no permitida en la etapa del lote (`meta.stage`, `meta.allowed`) |
| `TRC_LOT_TERMINAL` | 409 | Escritura en un lote `REJECTED`, `DISCARDED` o `CERTIFIED` |
| `TRC_PRODUCT_NOT_SUPPORTED` | 422 | Tipo distinto de `WINE`/`SINGANI` |
| `TRC_HARVEST_YEAR_MISMATCH` | 422 | Pesaje de otra añada |
| `TRC_DO_TERROIR_NOT_ELIGIBLE` | 422 | Parcela no apta D.O. para un lote singani |
| `TRC_DO_NOT_ELIGIBLE` | 422 | Lote no apto D.O. al bifurcar o destilar (y como incidencia) |
| `TRC_TERROIR_IN_USE` | 409 | `PATCH` de un campo normativo en una parcela usada |
| `TRC_PHYTO_IN_CREATE` | 422 | Dictamen en el alta del pesaje (EA-04) |
| `TRC_PHYTO_NOT_APPROVED` | 422 | Uva sin dictamen aprobado hacia un tanque |
| `TRC_PHYTO_DECISION_FINAL` | 409 | Dictamen sobre uno final o sobre uva ya en un tanque |
| `TRC_MIXED_LOTS` | 422 | Entradas de lotes distintos en un tanque |
| `TRC_TANK_CODE_IN_USE` | 409 | Tanque físico ocupado |
| `TRC_TANK_CAPACITY_EXCEEDED` | 422 | Llenado mayor que la capacidad |
| `TRC_TANK_INVALID_TRANSITION` | 409 | Transición de tanque no válida (paso 2.3) |
| `TRC_TANK_NOT_ACTIVE` | 409 | Lectura o tratamiento en un tanque cerrado |
| `TRC_TANK_NOT_COMPLETED` | 409 | Crianza o destilación desde un tanque sin completar (paso 2.3) |
| `TRC_DESTINATION_MISMATCH` | 422 | Destino incoherente con el tipo del lote |
| `TRC_VOLUME_EXCEEDS_AVAILABLE` | 422 | Kilos o litros por encima de lo disponible |
| `TRC_VOLUME_MISSING` | 422 | Volumen imprescindible sin registrar (también como incidencia) |
| `TRC_AGING_BELOW_MINIMUM` | 422 | Crianza bajo el mínimo de la instantánea |
| `TRC_MASS_BALANCE_EXCEEDED` | 422 | Cortes de destilación mayores que la entrada |
| `TRC_DISTILLATION_ALREADY_CLOSED` | 409 | Cerrar dos veces (paso 2.4) |
| `TRC_LOCK_NOT_RELEASED` | 422 | Embotellar antes del candado (reloj de la base) |
| `TRC_PRODUCT_TYPE_MISMATCH` | 422 | `productType` enviado distinto del derivado del origen |
| `TRC_BOTTLING_SOURCE_INVALID` | 422 | Fuente de otro lote, de otro tipo o no lista |
| `TRC_BOTTLING_SOURCES_PENDING` | 422 | Fuentes abiertas del lote sin incluir ni descartar |
| `TRC_LOT_ALREADY_BOTTLED` | 409 | Segundo embotellado del lote |
| `TRC_BOTTLING_EXCEEDS_VOLUME` | 422 | Botellas × volumen > disponible (`meta.maxBottles`) |
| `TRC_BOTTLING_LOSS_ABOVE_TOLERANCE` | 422 | Merma por encima de la tolerada |
| `TRC_ALCOHOL_BALANCE_EXCEEDED` | 422 | Alcohol puro embotellado > disponible |
| `TRC_DILUTION_NOT_ALLOWED` | 422 | Agua en un vino |
| `TRC_COMPLIANCE_ISSUES_OPEN` | 422 | Embotellar o cerrar con incidencias abiertas |
| `TRC_LOT_NOT_BOTTLED` | 409 | Laboratorio o códigos antes del embotellado |
| `TRC_BOTTLE_CODE_NOT_FOUND` | 404 | Código de botella inexistente o de otra bodega |
| `TRC_BOTTLE_CODE_ALREADY_VOIDED` | 409 | Anular dos veces |
| `TRC_EXPORT_NOT_READY` | 409 | Descarga de una exportación pendiente |
| `TRC_CORRECTION_FIELD_NOT_CORRECTABLE` | 422 | Campo fuera de la lista de corregibles |
| `TRC_CORRECTION_BREAKS_RULES` | 422 | La corrección incumple una regla |
| `TRC_DOSSIER_NOT_READY` | 422 | Cierre del expediente sin requisitos |
| `TRC_DOSSIER_CLOSED` | 409 | Escritura tras el cierre |
| `TRC_DATE_IN_FUTURE` | 422 | Fecha futura |
| `TRC_DATE_BEFORE_PREVIOUS_STAGE` | 422 | Fecha anterior a la etapa previa |
| `TRC_FILE_NOT_FOUND` | 422 | `key` de archivo inexistente o ajena |
| `TRC_REPORT_TOO_LARGE` | 422 | Reporte con más de 10 000 filas |
| `TRC_PLATFORM_READ_ONLY` | 403 | Escritura de la plataforma en la trazabilidad (S-25) |
| `PUB_CODE_NOT_FOUND` | 404 | Pasaporte inexistente |
| `PUB_CODE_MALFORMED` | 422 | Código imposible o con control inválido |
| `PUB_TOO_MANY_LOOKUPS` | 429 | Demasiados códigos inexistentes (`Retry-After`) |
| `NOT_IMPLEMENTED` | 501 | Ruta del contrato publicada sin lógica todavía |

### ERP — Embotellado
| Código | HTTP | Descripción |
|---|---|---|
| `BOTTLING_BATCH_NOT_FOUND` | 404 | |
| `BOTTLING_BATCH_SOURCE_LOCKED` | 422 | El lote origen no está listo (en aging o reposo) |
| `BOTTLING_BATCH_NO_LAB_ANALYSIS` | 422 | No hay análisis de laboratorio conforme |
| `BOTTLING_BATCH_ALREADY_ANCHORED` | 409 | El lote ya está anclado on-chain |
| `BOTTLING_BATCH_LOT_CODE_DUPLICATE` | 409 | |

### Tokenización
| Código | HTTP | Descripción |
|---|---|---|
| `COLLECTION_NOT_FOUND` | 404 | |
| `COLLECTION_NOT_PUBLISHED` | 422 | La colección no está publicada |
| `COLLECTION_SOLD_OUT` | 422 | Sin unidades disponibles |
| `COLLECTION_BATCH_NOT_ANCHORED` | 422 | El lote aún no está anclado on-chain |
| `TOKEN_NOT_FOUND` | 404 | |
| `TOKEN_NOT_OWNED` | 403 | El token no pertenece al usuario |
| `TOKEN_ALREADY_BURNED` | 422 | La botella ya fue retirada |

### Órdenes y Pagos
| Código | HTTP | Descripción |
|---|---|---|
| `ORDER_NOT_FOUND` | 404 | |
| `ORDER_ALREADY_PAID` | 409 | Intento de pagar una orden ya pagada |
| `ORDER_EXPIRED` | 422 | La orden expiró sin pago |
| `PAYMENT_WEBHOOK_INVALID_SIGNATURE` | 401 | Firma del webhook no válida |
| `PAYMENT_CHARGE_ALREADY_PROCESSED` | 409 | Idempotencia: cobro ya procesado |

### Claims y POS
| Código | HTTP | Descripción |
|---|---|---|
| `CLAIM_PASS_NOT_FOUND` | 404 | |
| `CLAIM_PASS_EXPIRED` | 422 | El pase QR expiró |
| `CLAIM_PASS_ALREADY_USED` | 422 | El pase ya fue usado para retiro |
| `CLAIM_PASS_WRONG_LOCATION` | 422 | El pase es para otro punto de retiro |
| `CLAIM_PASS_INVALID_HASH` | 422 | El hash del QR no coincide con el registrado |
| `CLAIM_ACTIVE_PASS_EXISTS` | 409 | Ya existe un pase activo para este token |
| `POS_LOCATION_NOT_FOUND` | 404 | |
| `POS_SHIFT_NOT_OPEN` | 422 | No hay turno abierto en este POS |
| `POS_UNAUTHORIZED` | 403 | El POS no está autorizado en el contrato C-05 |

### Validación General
| Código | HTTP | Descripción |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Falló la validación del DTO, la query o un campo (ver `details`). Ajustado por A-33: antes 400 |
| `BAD_REQUEST` | 400 | Petición mal formada (JSON inválido, parámetro de ruta que no es UUID) |
| `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` | 401 / 403 / 404 / 409 | Genéricos, cuando la excepción no trae código propio. Un recurso de otra organización es **404**, nunca 403 |
| `UNPROCESSABLE_ENTITY` | 422 | Regla de negocio sin código propio |
| `TOO_MANY_REQUESTS` | 429 | Límite de peticiones; la respuesta lleva `Retry-After` (segundos) |
| `RESOURCE_NOT_FOUND` | 404 | Recurso genérico no encontrado |
| `INTERNAL_ERROR` | 500 | Error interno del servidor |
| `STELLAR_TX_FAILED` | 502 | La transacción en Stellar falló |
| `STELLAR_RPC_UNAVAILABLE` | 503 | No se puede conectar a Stellar RPC |

---

## Paginación (ajustado por A-33, 27-09-2026)

> Las reglas originales usaban `page`/`sortBy`/`sortOrder` y `pagination.totalPages…`. A-33 fija `limit`/`offset` y la página `{ items, total, limit, offset }` (contrato O0 §2).

### Query params estándar
```
GET /v1/harvest-batches?limit=20&offset=40&harvestYear=2026
```

| Param | Default | Rango | Descripción |
|---|---|---|---|
| `limit` | 20 | 1–100 | Resultados por página. Fuera de rango → 422 `VALIDATION_ERROR` en `limit` |
| `offset` | 0 | ≥ 0 | Resultados que se saltan. Negativo → 422 en `offset` |

El orden lo fija cada colección (por defecto, fecha de alta descendente).

### DTO de consulta reutilizable
```typescript
// src/shared/dto/pagination-query.dto.ts
export class PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit: number = 20;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset: number = 0;
}

// Las consultas con filtros la extienden
export class QueryHarvestBatchesDto extends PaginationQueryDto { /* filtros */ }
```

### Servicio y controlador
```typescript
// Servicio
const [items, total] = await Promise.all([
  this.prisma.harvestBatch.findMany({ where, ...toPrismaPage(query), orderBy }),
  this.prisma.harvestBatch.count({ where }),
]);
return toPage(items, total, query); // { items, total, limit, offset }

// Controlador: declara la página en OpenAPI (y el 422 de limit/offset)
@Get()
@ApiPaginatedResponse(HarvestBatchResponseDto, { description: 'Página de lotes' })
findAll(@Query() query: QueryHarvestBatchesDto) { … }
```

Una prueba (`src/openapi/__tests__/openapi.spec.ts`) recorre el OpenAPI y falla si una colección no declara la página o si alguna respuesta es un array plano.

---

## Idempotency-Key (A-33, contrato O0 §3)

- Cabecera `Idempotency-Key: <UUID>`, permitida en CORS. Se acepta en cualquier `POST`; las operaciones marcadas con `@Idempotent()` la aplican (hoy, las altas del ERP; desde la Ola 3, obligatoria con `@Idempotent({ required: true })` en pedidos, pases, canjes, aprobaciones de tokenización y reembolsos).
- Clave de almacenamiento en Redis: persona + método y ruta + clave. Se guarda la huella SHA-256 del cuerpo (JSON canónico) y la respuesta durante **24 h**.
- Misma clave y mismo cuerpo → la misma respuesta guardada, sin volver a ejecutar la operación (cabecera `Idempotent-Replayed: true`).
- Misma clave con otro cuerpo → 409 `IDEMPOTENCY_KEY_REUSED`. Misma clave mientras la primera sigue en curso → 409 `IDEMPOTENCY_IN_PROGRESS` (reserva atómica `SET NX` de 120 s).
- Si la operación falla (4xx/5xx), la clave se libera y se puede reintentar con ella.

```typescript
@Post()
@HttpCode(HttpStatus.CREATED)
@Idempotent()
create(@Body() dto: CreateTerroirDto) { … }
```

---

## Convenciones Adicionales

### Números, decimales y fechas (27-09-2026)
- Toda columna `Decimal` sale como **número JSON** (`"surfaceHectares": 5`), nunca como texto: `ResponseTransformInterceptor` convierte los `Prisma.Decimal` de `data` (`decimalsToNumbers`, `src/shared/utils/decimal-json.util.ts`). No hace falta `Number(...)` en los servicios.
- En OpenAPI, un campo anulable declara su tipo y `nullable: true` (`@ApiPropertyOptional({ type: Number, nullable: true })`); sin `type`, `@nestjs/swagger` lo publica como `object`.
- Las columnas `Decimal` no pasan de 15 dígitos (caben en un `double`). El dinero va en **enteros de centavos**, no en decimales.
- Fechas en ISO 8601 UTC (`2026-09-27T12:00:00.000Z`).
- La bitácora (`before`/`after`) guarda los decimales como texto exacto: es lo que se usó para el hash.
- Cada e2e puede validar sus respuestas con `loadOpenApiValidator()` (`test/helpers/openapi-validator.ts`).

### `null` en los cuerpos (27-09-2026)
- En un campo **opcional** (`@IsOptional()`), `null` equivale a **omitirlo**: lo quita el `ValidationPipe` global (`AppValidationPipe`, `src/shared/pipes/optional-nulls.ts`) antes de validar. Así un alta con `latitude: null` crea la parcela sin latitud y un PATCH con `surfaceHectares: null` no cambia la superficie (antes, 500).
- Si en un PATCH `null` debe **borrar** el dato (columna anulable), el DTO lo declara: `@NullableFields('latitude', …)` en la clase (p. ej. `UpdateTerroirDto`); el servicio recibe `null`.
- En un campo **obligatorio**, `null` es un 422 `VALIDATION_ERROR` con el campo en `details`.
- Solo se mira el primer nivel del cuerpo (los objetos libres como el GeoJSON no se tocan). Toda operación con cuerpo declara su 422 en `openapi.json`.

### POST que crea un recurso → 201 Created
```typescript
@Post()
@HttpCode(HttpStatus.CREATED)
async create(@Body() dto: CreateHarvestBatchDto) { ... }
```

### POST que ejecuta una acción → 200 OK
```typescript
@Post(':id/approve')
@HttpCode(HttpStatus.OK)
async approve(@Param('id', ParseUuidPipe) id: string) { ... }
```

### DELETE exitoso → 204 No Content
```typescript
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
async remove(@Param('id', ParseUuidPipe) id: string) { ... }
```

### Webhooks → siempre 200 OK (nunca 4xx al proveedor)
```typescript
@Post()
@HttpCode(HttpStatus.OK)
async handleWebhook(@Body() payload: unknown, @Headers() headers: Record<string, string>) {
  // Si el webhook falla, retornar 200 igualmente para evitar reintentos del proveedor
  // Registrar el error internamente en lugar de lanzar excepción HTTP
  try {
    await this.paymentsService.verifyAndProcess(payload, headers);
  } catch (error) {
    this.logger.error('Webhook processing failed', error);
    // No relanzar — el proveedor de pagos interpretará un 4xx como fallo y reintentará
  }
  return { received: true };
}
```
