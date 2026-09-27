import type { ClientApp } from '@shared/context/request-context';

/** Quién actuó. `userId: null` = el sistema (worker, tarea programada). */
export interface AuditActor {
  userId: string | null;
  fullName: string | null;
  role: string | null;
  organizationId: string | null;
  /** Actuó el personal de la plataforma (back office) sobre un tercero. */
  viaPlatform: boolean;
}

/** Desde dónde. */
export interface AuditSource {
  app: ClientApp;
  ip: string | null;
  deviceId: string | null;
}

/** Recurso afectado: tipo estable (`winery`, `terroir`, `setting`…) e id. */
export interface AuditResource {
  type: string;
  id: string | null;
}

/**
 * Entrada que escribe un servicio. Actor, origen y correlación salen del
 * contexto de la petición salvo que se indiquen; `actor: null` fuerza
 * "sistema".
 */
export interface AuditEventInput {
  /** Código estable en UPPER_SNAKE_CASE (`WINERY_APPROVED`), ver `audit.actions.ts`. */
  action: string;
  resource: { type: string; id?: string | null };
  /** Organización afectada (la bodega del recurso). */
  organizationId?: string | null;
  /** Valores antes y después; se sanean (sin contraseñas, tokens ni secretos). */
  before?: unknown;
  after?: unknown;
  /** Motivo (obligatorio en acciones del back office sobre terceros, AUD-05). */
  reason?: string | null;
  actor?: Partial<AuditActor> | null;
  source?: Partial<AuditSource>;
  correlationId?: string | null;
  sessionId?: string | null;
}

/** Forma pública de una entrada (contrato O1 §7). */
export interface AuditEventView {
  id: string;
  seq: number;
  occurredAt: string;
  actor: AuditActor;
  source: AuditSource;
  action: string;
  resource: AuditResource;
  organizationId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  correlationId: string | null;
  hash: string;
  prevHash: string | null;
}

/** Resultado de `verifyChain` (contrato O1 §7, `GET /platform/audit/verify`). */
export interface AuditChainVerification {
  valid: boolean;
  checked: number;
  firstBrokenSeq: number | null;
}
