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

export class DomainException extends AppException {
  constructor(errorCode: string, message: string, details?: unknown) {
    super(422, errorCode, message, details);
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(resource: string, id: string) {
    super(
      404,
      `${resource.toUpperCase().replace(/\s+/g, '_')}_NOT_FOUND`,
      `${resource} ${id} not found`,
    );
  }
}

export class TenantMismatchException extends AppException {
  constructor() {
    super(
      403,
      'AUTH_TENANT_MISMATCH',
      'Resource does not belong to your organization',
    );
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
    super(
      503,
      'STELLAR_RPC_UNAVAILABLE',
      'Stellar network is temporarily unavailable. Please try again.',
    );
  }
}

/**
 * 429 con `Retry-After` exacto (el filtro global copia `retryAfterSeconds` a
 * la cabecera). Lo usa el bloqueo progresivo del inicio de sesión (IAM-07).
 */
export class RetryAfterException extends AppException {
  constructor(
    errorCode: string,
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(429, errorCode, message);
  }
}
