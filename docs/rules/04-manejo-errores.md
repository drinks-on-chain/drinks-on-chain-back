# Manejo de Errores — Drinks on Chain

> Las excepciones se manejan de forma centralizada mediante un `HttpExceptionFilter` global.  
> Nunca se exponen stack traces al cliente en producción.  
> Todas las excepciones de dominio tienen un código de error semántico (ver `03-formato-respuestas.md`).

---

## Jerarquía de Excepciones

```
Error (Node.js)
└── HttpException (NestJS)
    ├── BadRequestException        → 400
    ├── UnauthorizedException      → 401
    ├── ForbiddenException         → 403
    ├── NotFoundException          → 404
    ├── ConflictException          → 409
    └── UnprocessableEntityException → 422
         
AppException (custom, base)       ← Excepciones de dominio del proyecto
├── DomainException               ← Regla de negocio violada
├── TenantException               ← Violación de multi-tenancy
├── BlockchainException           ← Error de Stellar/Soroban
└── StorageException              ← Error de Storage
```

---

## Excepción Base del Dominio

```typescript
// src/shared/exceptions/app.exception.ts

export class AppException extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    public readonly message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Excepciones específicas de dominio
export class DomainException extends AppException {
  constructor(errorCode: string, message: string, details?: unknown) {
    super(422, errorCode, message, details);
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(resource: string, id: string) {
    super(404, `${resource.toUpperCase()}_NOT_FOUND`, `${resource} ${id} not found`);
  }
}

export class TenantMismatchException extends AppException {
  constructor() {
    super(403, 'AUTH_TENANT_MISMATCH', 'Resource does not belong to your organization');
  }
}

export class ConflictException extends AppException {
  constructor(errorCode: string, message: string) {
    super(409, errorCode, message);
  }
}

export class BlockchainException extends AppException {
  constructor(message: string, details?: unknown) {
    super(502, 'STELLAR_TX_FAILED', message, details);
  }
}

export class BlockchainUnavailableException extends AppException {
  constructor() {
    super(503, 'STELLAR_RPC_UNAVAILABLE', 'Stellar network is temporarily unavailable. Please try again.');
  }
}
```

---

## Fábrica de Excepciones de Dominio

```typescript
// src/shared/exceptions/domain-errors.ts
// Un solo lugar donde se definen todos los errores de negocio

import { DomainException, ConflictException, ResourceNotFoundException } from './app.exception';

// ── COSECHAS ──────────────────────────────────────────────
export const HarvestErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Harvest batch', id),
  notApproved: () => new DomainException(
    'HARVEST_BATCH_NOT_APPROVED',
    'Harvest batch must be approved before fermentation',
  ),
  codeDuplicate: (code: string) => new ConflictException(
    'HARVEST_BATCH_CODE_DUPLICATE',
    `Harvest batch code '${code}' already exists`,
  ),
} as const;

// ── EMBOTELLADO ────────────────────────────────────────────
export const BottlingErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Bottling batch', id),
  sourceLocked: () => new DomainException(
    'BOTTLING_BATCH_SOURCE_LOCKED',
    'Source batch is not ready for bottling. Check aging or rest period status.',
  ),
  noLabAnalysis: () => new DomainException(
    'BOTTLING_BATCH_NO_LAB_ANALYSIS',
    'A conforming lab analysis is required before releasing a batch',
  ),
  alreadyAnchored: () => new ConflictException(
    'BOTTLING_BATCH_ALREADY_ANCHORED',
    'This batch is already anchored on the blockchain',
  ),
} as const;

// ── TOKENIZACIÓN ───────────────────────────────────────────
export const CollectionErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Collection', id),
  notPublished: () => new DomainException(
    'COLLECTION_NOT_PUBLISHED',
    'Collection is not available for purchase',
  ),
  soldOut: () => new DomainException(
    'COLLECTION_SOLD_OUT',
    'No units available in this collection',
  ),
  batchNotAnchored: () => new DomainException(
    'COLLECTION_BATCH_NOT_ANCHORED',
    'The bottling batch must be anchored on-chain before tokenizing',
  ),
} as const;

export const TokenErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Token', id),
  notOwned: () => new DomainException('TOKEN_NOT_OWNED', 'You do not own this token'),
  alreadyBurned: () => new DomainException('TOKEN_ALREADY_BURNED', 'This bottle has already been redeemed'),
} as const;

// ── CLAIMS ────────────────────────────────────────────────
export const ClaimErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Claim pass', id),
  expired: () => new DomainException('CLAIM_PASS_EXPIRED', 'Claim pass has expired'),
  alreadyUsed: () => new DomainException('CLAIM_PASS_ALREADY_USED', 'Claim pass has already been used'),
  wrongLocation: () => new DomainException(
    'CLAIM_PASS_WRONG_LOCATION',
    'This claim pass is not valid for this pickup location',
  ),
  invalidHash: () => new DomainException(
    'CLAIM_PASS_INVALID_HASH',
    'Claim pass data is invalid or has been tampered with',
  ),
  activePassExists: () => new ConflictException(
    'CLAIM_ACTIVE_PASS_EXISTS',
    'An active claim pass already exists for this token',
  ),
} as const;

// ── PAGOS ─────────────────────────────────────────────────
export const PaymentErrors = {
  invalidWebhookSignature: () => new DomainException(
    'PAYMENT_WEBHOOK_INVALID_SIGNATURE',
    'Webhook signature verification failed',
  ),
  alreadyProcessed: (chargeId: string) => new ConflictException(
    'PAYMENT_CHARGE_ALREADY_PROCESSED',
    `Charge ${chargeId} has already been processed`,
  ),
} as const;
```

---

## Exception Filter Global

```typescript
// src/shared/filters/http-exception.filter.ts

import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from '../exceptions/app.exception';
import { ApiErrorResponse } from '../interfaces/api-response.interface';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const errorResponse = this.buildErrorResponse(exception, request.url);

    // Log del error
    if (errorResponse.statusCode >= 500) {
      this.logger.error(
        `[${errorResponse.statusCode}] ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${errorResponse.statusCode}] ${request.method} ${request.url} — ${errorResponse.error.code}`,
      );
    }

    response.status(errorResponse.statusCode).json(errorResponse);
  }

  private buildErrorResponse(exception: unknown, path: string): ApiErrorResponse {
    const timestamp = new Date().toISOString();

    // Excepción de dominio del proyecto
    if (exception instanceof AppException) {
      return {
        success: false,
        statusCode: exception.statusCode,
        timestamp,
        path,
        error: {
          code: exception.errorCode,
          message: exception.message,
          details: null,
        },
      };
    }

    // Excepción de NestJS (NotFoundException, BadRequestException, etc.)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse() as Record<string, unknown>;

      // Errores de validación (vienen con { code, details } del ValidationPipe)
      if (status === HttpStatus.BAD_REQUEST && exceptionResponse?.code === 'VALIDATION_ERROR') {
        return {
          success: false,
          statusCode: status,
          timestamp,
          path,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: exceptionResponse.details as never,
          },
        };
      }

      return {
        success: false,
        statusCode: status,
        timestamp,
        path,
        error: {
          code: this.mapHttpStatusToCode(status),
          message: typeof exceptionResponse?.message === 'string'
            ? exceptionResponse.message
            : exception.message,
          details: null,
        },
      };
    }

    // Error no esperado
    return {
      success: false,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      timestamp,
      path,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        details: null,
      },
    };
  }

  private mapHttpStatusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      500: 'INTERNAL_ERROR',
      502: 'BAD_GATEWAY',
      503: 'SERVICE_UNAVAILABLE',
    };
    return map[status] ?? 'UNKNOWN_ERROR';
  }
}
```

---

## Reglas de Uso

### ✅ Usar excepciones de dominio, no strings genéricos
```typescript
// ❌ MAL
throw new NotFoundException('Not found');
throw new BadRequestException('The batch cannot be released');

// ✅ BIEN
throw BottlingErrors.notFound(batchId);
throw BottlingErrors.noLabAnalysis();
throw ClaimErrors.expired();
```

### ✅ Verificar pertenencia al tenant en TODOS los recursos
```typescript
// src/shared/helpers/tenant-resource.helper.ts

export function assertBelongsToTenant<T extends { wineryId: string }>(
  resource: T | null,
  resourceName: string,
  id: string,
  tenantId: string,
): asserts resource is T {
  if (!resource) {
    throw new ResourceNotFoundException(resourceName, id);
  }
  if (resource.wineryId !== tenantId) {
    // NO decir "pertenece a otro tenant" — security by obscurity
    throw new ResourceNotFoundException(resourceName, id);
    // Nota: devolvemos 404 (no 403) para no revelar que el recurso existe
  }
}

// Uso:
const batch = await this.prisma.harvestBatch.findUnique({ where: { id } });
assertBelongsToTenant(batch, 'Harvest batch', id, tenantId);
// A partir de aquí, TypeScript sabe que batch no es null
```

### ✅ Never throw en background workers / BullMQ — usar reintentos
```typescript
// ❌ MAL — el job falla y no reintenta controladamente
async process(job: Job<MintNftJobData>) {
  const result = await this.stellarService.mintNft(job.data);
  // Si esto lanza, BullMQ reintentará pero sin control nuestro
}

// ✅ BIEN — control explícito de errores en jobs
async process(job: Job<MintNftJobData>) {
  try {
    const result = await this.stellarService.mintNft(job.data);
    await this.tokenService.markMinted(job.data.tokenId, result.txHash);
  } catch (error) {
    this.logger.error(`Mint job failed for token ${job.data.tokenId}`, {
      attempt: job.attemptsMade,
      error: error instanceof Error ? error.message : String(error),
    });
    
    // Registrar el intento fallido en BD para monitoreo
    await this.tokenService.recordMintFailure(job.data.tokenId, error);
    
    // Re-lanzar para que BullMQ aplique el backoff y reintente
    throw error;
  }
}
```

### ✅ Errores de Stellar — siempre con contexto
```typescript
// ❌ MAL
throw new Error('Stellar failed');

// ✅ BIEN
throw new BlockchainException(
  `Failed to mint token ${tokenId} for wallet ${walletAddress}`,
  { 
    txHash: partialTxHash, 
    ledger: lastLedger,
    contractError: error.message,
  },
);
```

### ✅ Nunca exponer datos internos en errores de producción
```typescript
// ❌ MAL — expone detalles internos
catch (error) {
  throw new InternalServerErrorException(error.message); // puede exponer info de BD
}

// ✅ BIEN — el filter global ya maneja esto, solo loggear y relanzar
catch (error) {
  this.logger.error('Database operation failed', error);
  throw new AppException(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}
```
