# Formato de Respuestas de la API — Drinks on Chain

> Todos los endpoints del sistema devuelven respuestas en el mismo formato estructurado.  
> Implementado via `ResponseTransformInterceptor` global.

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

### Respuesta de lista con paginación
```json
{
  "success": true,
  "statusCode": 200,
  "timestamp": "2026-08-28T21:00:00.000Z",
  "path": "/v1/harvest-batches",
  "data": {
    "items": [ ... ],
    "pagination": {
      "total": 47,
      "page": 1,
      "limit": 20,
      "totalPages": 3,
      "hasNextPage": true,
      "hasPrevPage": false
    }
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

### Respuesta de error de validación (400)
```json
{
  "success": false,
  "statusCode": 400,
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

---

## Implementación

### Interfaz de respuesta
```typescript
// src/shared/interfaces/api-response.interface.ts

export interface ApiSuccessResponse<T> {
  success: true;
  statusCode: number;
  timestamp: string;
  path: string;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  timestamp: string;
  path: string;
  error: {
    code: string;
    message: string;
    details: ValidationErrorDetail[] | null;
  };
}

export interface ValidationErrorDetail {
  field: string;
  message: string;
}

export interface PaginatedData<T> {
  items: T[];
  pagination: PaginationMeta;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}
```

### Interceptor de transformación global
```typescript
// src/shared/interceptors/response-transform.interceptor.ts

import {
  Injectable, NestInterceptor, ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { ApiSuccessResponse } from '../interfaces/api-response.interface';

@Injectable()
export class ResponseTransformInterceptor<T>
  implements NestInterceptor<T, ApiSuccessResponse<T>> {

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiSuccessResponse<T>> {
    const request = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      map((data) => ({
        success: true,
        statusCode: context.switchToHttp().getResponse().statusCode,
        timestamp: new Date().toISOString(),
        path: request.url,
        data,
      })),
    );
  }
}
```

### Registro global en main.ts
```typescript
// src/main.ts
app.useGlobalInterceptors(new ResponseTransformInterceptor());
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,          // elimina campos no declarados en el DTO
  forbidNonWhitelisted: true, // lanza error si llegan campos no declarados
  transform: true,          // transforma strings a sus tipos (ej. "42" → 42)
  exceptionFactory: (errors) => {
    const details = errors.map(e => ({
      field: e.property,
      message: Object.values(e.constraints ?? {}).join(', '),
    }));
    throw new BadRequestException({ code: 'VALIDATION_ERROR', details });
  },
}));
```

---

## Códigos de Error del Dominio

> Los códigos de error son `UPPER_SNAKE_CASE` y siempre tienen prefijo del dominio.  
> Permiten al cliente identificar el tipo de error sin parsear el mensaje.

### Autenticación y Autorización
| Código | HTTP | Descripción |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Email o contraseña incorrectos |
| `AUTH_TOKEN_EXPIRED` | 401 | JWT expirado |
| `AUTH_TOKEN_INVALID` | 401 | JWT inválido o malformado |
| `AUTH_INSUFFICIENT_PERMISSIONS` | 403 | Rol insuficiente para la operación |
| `AUTH_TENANT_MISMATCH` | 403 | El recurso no pertenece al tenant del usuario |

### Multi-tenant
| Código | HTTP | Descripción |
|---|---|---|
| `TENANT_NOT_FOUND` | 404 | Bodega no encontrada |
| `TENANT_NOT_ACTIVE` | 403 | Bodega suspendida o revocada |
| `TENANT_ALREADY_REGISTERED` | 409 | Bodega ya registrada on-chain |

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
| `FERMENTATION_TANK_WRONG_STATUS` | 422 | Operación no válida en el estado actual |
| `FERMENTATION_TANK_DESTINATION_LOCKED` | 422 | El destino ya fue definido y no puede cambiarse |

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
| `VALIDATION_ERROR` | 400 | Falló la validación del DTO (ver `details`) |
| `RESOURCE_NOT_FOUND` | 404 | Recurso genérico no encontrado |
| `INTERNAL_ERROR` | 500 | Error interno del servidor |
| `STELLAR_TX_FAILED` | 502 | La transacción en Stellar falló |
| `STELLAR_RPC_UNAVAILABLE` | 503 | No se puede conectar a Stellar RPC |

---

## Paginación

### Query params estándar
```
GET /v1/harvest-batches?page=1&limit=20&sortBy=createdAt&sortOrder=desc
```

| Param | Default | Máximo | Descripción |
|---|---|---|---|
| `page` | 1 | — | Página actual (1-indexed) |
| `limit` | 20 | 100 | Registros por página |
| `sortBy` | `createdAt` | — | Campo por el que ordenar |
| `sortOrder` | `desc` | — | `asc` o `desc` |

### DTO de paginación reutilizable
```typescript
// src/shared/dto/pagination-query.dto.ts
import { Type } from 'class-transformer';
import { IsOptional, IsInt, Min, Max, IsString, IsEnum } from 'class-validator';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}
```

### Helper de paginación para Prisma
```typescript
// src/shared/helpers/pagination.helper.ts

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number,
): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

export function buildPrismaSkipTake(page: number, limit: number) {
  return {
    skip: (page - 1) * limit,
    take: limit,
  };
}
```

---

## Convenciones Adicionales

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
