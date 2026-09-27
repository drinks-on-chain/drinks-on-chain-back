# Manejo de Logs — Drinks on Chain

> El registro de logs (logging) es fundamental para la observabilidad, auditoría, debugging y monitoreo de transacciones blockchain y financieras.
> Estas reglas establecen estándares estrictos de niveles, estructura, trazabilidad y protección de datos sensibles.

---

## 1. Principios de Logging

1. **Logs Estructurados (JSON en Producción):** Los logs deben ser procesables por herramientas de observabilidad (Datadog, CloudWatch, Loki, Logtail).
2. **Contexto Obligatorio:** Todo log debe indicar de qué clase/módulo proviene (`new Logger(ContextName.name)`).
3. **Trazabilidad de Peticiones (Correlation ID / Request ID):** Cada request HTTP o trabajo en cola debe portar un `correlationId` para rastrear su ciclo de vida completo.
4. **Cero Fuga de Datos Sensibles (PII & Secretos):** Nunca registrar llaves privadas de Stellar, PINs, passwords, tokens JWT completos ni datos bancarios.
5. **No Usar `console.log`:** Queda estrictamente prohibido el uso de `console.log`, `console.error` o `console.warn`. Siempre usar el servicio `Logger` de NestJS / Winston / Pino.

---

## 2. Niveles de Log y Criterios de Uso

| Nivel | Método | Cuándo usarlo | Ejemplo |
|---|---|---|---|
| **ERROR** | `logger.error()` | Fallos críticos, excepciones no controladas, fallos en transacciones blockchain o pagos tras reintentos agotados. Requiere atención inmediata. | `"Failed to anchor batch on Stellar after 3 retries"` |
| **WARN** | `logger.warn()` | Situaciones anómalas pero recuperables: reintentos de jobs, tokens de claim expirados, firmas de webhook dudosas, accesos denegados. | `"Invalid webhook signature attempt from IP: 190.181.x.x"` |
| **LOG / INFO** | `logger.log()` | Eventos significativos del ciclo de vida del negocio: órdenes creadas, NFTs minteados, lotes liberados, aperturas de turno POS. | `"Order ORD-2026-001 confirmed. Queuing mint job."` |
| **DEBUG** | `logger.debug()` | Información detallada útil para desarrollo y debugging: payloads procesados, cálculos de SHA-256 intermedios, queries ejecutadas. | `"Calculated batch SHA-256 data hash: a1b2c3..."` |
| **VERBOSE** | `logger.verbose()` | Trazas de bajo nivel: inicio y fin de métodos internos, polling de indexer sin eventos nuevos. | `"Stellar indexer polled ledger 123456 - 0 new events"` |

---

## 3. Trazabilidad con Correlation ID (Request Tracing)

Implementamos un `CorrelationIdMiddleware` que extrae el header `X-Correlation-ID` o genera un UUID nuevo, almacenándolo en `AsyncLocalStorage`.

```typescript
// src/shared/middleware/correlation-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AsyncLocalStorage } from 'async_hooks';

export const asyncLocalStorage = new AsyncLocalStorage<Map<string, string>>();

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    res.setHeader('X-Correlation-ID', correlationId);

    const store = new Map<string, string>();
    store.set('correlationId', correlationId);

    asyncLocalStorage.run(store, () => {
      next();
    });
  }
}
```

---

## 4. Estructura Estándar de Log

### Formato JSON para Producción
```json
{
  "timestamp": "2026-08-28T21:45:00.123Z",
  "level": "INFO",
  "context": "StellarService",
  "correlationId": "8f3b18d2-4f67-4e92-bc21-0c58f0efd912",
  "tenantId": "winery-uuid-1234",
  "userId": "user-uuid-5678",
  "message": "Product NFT minted successfully",
  "metadata": {
    "tokenId": "DOC-NFT-0012",
    "txHash": "3b29c9a0...",
    "ledgerSequence": 5421098
  }
}
```

### Uso en Servicios NestJS

```typescript
// src/modules/stellar/stellar.service.ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);

  async mintProductNft(params: MintNftParams) {
    this.logger.log(`Initiating mint for token ${params.tokenId}`, {
      tokenId: params.tokenId,
      recipient: params.recipientAddress,
      collectionId: params.collectionId,
    });

    try {
      const txResult = await this.executeMintTransaction(params);

      this.logger.log(`NFT minted successfully for token ${params.tokenId}`, {
        tokenId: params.tokenId,
        txHash: txResult.hash,
        ledger: txResult.ledger,
      });

      return txResult;
    } catch (error) {
      this.logger.error(`Mint transaction failed for token ${params.tokenId}`, {
        tokenId: params.tokenId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}
```

---

## 5. Sanitización y Enmascaramiento de Datos Sensibles

Queda terminantemente prohibido imprimir datos sensibles en logs. Se debe aplicar una función sanitizadora antes de volcar objetos a los logs.

### Lista Negra de Campos Sensibles
- `password`, `password_hash`, `newPassword`
- `pin`, `pin_hash`
- `STELLAR_RELAYER_SECRET_KEY` o cualquier secret key (empieza por `S...`)
- `apiKey`, `apiSecret`, `webhookSecret`
- `creditCardNumber`, `cvv`, `cardNumber`
- `authorization` (Bearer tokens)

### Utilidad de Sanitización

```typescript
// src/shared/utils/log-sanitizer.util.ts
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'pin',
  'pin_hash',
  'secret',
  'api_key',
  'apiKey',
  'apiSecret',
  'webhookSecret',
  'private_key',
  'relayer_secret_key',
  'authorization',
  'cvv',
  'cardNumber',
]);

export function sanitizeLogData(data: unknown): unknown {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeLogData);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '***REDACTED***';
    } else if (typeof value === 'string' && value.startsWith('S') && value.length === 56) {
      // Enmascarar claves privadas de Stellar (Ed25519 Secret Seed)
      sanitized[key] = 'S***[STELLAR_SECRET_REDACTED]***';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLogData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
```

---

## 6. Logging HTTP Global (HTTP Interceptor)

Para auditar el tráfico entrante sin saturar con payloads innecesarios:

```typescript
// src/shared/interceptors/logging.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, originalUrl, ip } = request;
    const userAgent = request.get('user-agent') || '';
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const responseTime = Date.now() - startTime;
          const statusCode = context.switchToHttp().getResponse().statusCode;
          this.logger.log(
            `${method} ${originalUrl} ${statusCode} - ${responseTime}ms [IP: ${ip}] [Agent: ${userAgent}]`,
          );
        },
        error: (err) => {
          const responseTime = Date.now() - startTime;
          const status = err?.status || 500;
          this.logger.warn(
            `${method} ${originalUrl} ${status} - ${responseTime}ms [IP: ${ip}] [Error: ${err?.message || 'Unknown'}]`,
          );
        },
      }),
    );
  }
}
```

---

## 7. Categorías Especiales de Logs

### A. Logs de Blockchain (Stellar / Soroban)
Siempre deben incluir:
- Identificador lógico del contrato (`C01`, `C02`, `C03`, `C05`)
- Dirección del contrato
- Hash de la transacción (`txHash`)
- Número de ledger (`ledgerSequence`)
- Operación ejecutada (`anchor_batch`, `mint`, `burn`, `redeem_pass`)

### B. Logs de Auditoría Operacional (ERP & POS)
Para cambios críticos en el negocio (aprobación fitosanitaria, liberación de lote, quema física de botellas):
- ID del usuario que ejecuta la acción
- ID de la bodega / tenant
- Entidad y estado previo vs estado nuevo
- Timestamp de alta precisión
- IP y terminal de origen
