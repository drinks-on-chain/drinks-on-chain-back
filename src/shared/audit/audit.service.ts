import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditEvent, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { getRequestContext } from '@shared/context/request-context';
import { AuditHashable, computeAuditHash, findBrokenLink } from './audit-hash';
import { sanitizeAuditData } from './audit-sanitizer';
import {
  AuditChainVerification,
  AuditEventInput,
  AuditEventView,
} from './audit.types';

/**
 * Candado de transacción que serializa la escritura de la cabeza de la cadena
 * (`pg_advisory_xact_lock`). Se libera solo al confirmar o revertir.
 */
export const AUDIT_CHAIN_LOCK_KEY = 4_155_444_954; // "AUDIT"

/**
 * Opciones de las transacciones que abre el propio servicio: la espera por el
 * candado de la cadena cuenta dentro de la transacción, así que se da más
 * margen que el de Prisma por defecto (2 s para empezar, 5 s en total).
 */
export const AUDIT_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/** Filas por consulta al verificar la cadena. */
const VERIFY_BATCH_SIZE = 1000;

const ACTION_PATTERN = /^[A-Z][A-Z0-9_]{2,99}$/;

function truncate(value: string | null | undefined, max: number) {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function toHashable(row: AuditEvent): AuditHashable & { hash: string } {
  return {
    id: row.id,
    seq: Number(row.seq),
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    actorFullName: row.actorFullName,
    actorRole: row.actorRole,
    actorOrganizationId: row.actorOrganizationId,
    actorViaPlatform: row.actorViaPlatform,
    sourceApp: row.sourceApp,
    sourceIp: row.sourceIp,
    sourceDeviceId: row.sourceDeviceId,
    sessionId: row.sessionId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    organizationId: row.organizationId,
    before: row.before,
    after: row.after,
    reason: row.reason,
    correlationId: row.correlationId,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

/**
 * Bitácora (AUD-01, AUD-02; docs-back/07 §4, contrato O1 §7).
 *
 * - `record(tx, evento)` escribe la entrada **dentro de la transacción de la
 *   operación**: si la operación se revierte, la entrada no existe.
 * - Cada entrada lleva `seq` consecutivo y el hash SHA-256 de su contenido,
 *   que incluye el hash de la anterior. La cabeza se toma con un candado de
 *   transacción, así que dos operaciones simultáneas nunca comparten `seq`.
 * - La tabla es de solo inserción: un trigger rechaza `UPDATE`, `DELETE` y
 *   `TRUNCATE` (migración `audit_events`).
 *
 * Llama a `record` como **último paso** de la transacción: desde el candado
 * hasta la confirmación, las demás escrituras auditadas esperan.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Escribe una entrada con el cliente de una transacción en curso. */
  async record(
    tx: Prisma.TransactionClient,
    input: AuditEventInput,
  ): Promise<AuditEvent> {
    if (!tx || '$transaction' in tx) {
      throw new Error(
        'AuditService.record solo acepta el cliente de una transacción: úsalo dentro de prisma.$transaction(async (tx) => …)',
      );
    }
    if (!ACTION_PATTERN.test(input.action ?? '')) {
      throw new Error(
        `Acción de bitácora inválida: "${input.action}" (UPPER_SNAKE_CASE)`,
      );
    }
    if (!input.resource?.type) {
      throw new Error('Una entrada de bitácora necesita resource.type');
    }

    const ctx = getRequestContext();
    const actor =
      input.actor === null
        ? null
        : {
            userId: input.actor?.userId ?? ctx?.userId ?? null,
            fullName: input.actor?.fullName ?? ctx?.userFullName ?? null,
            role: input.actor?.role ?? ctx?.role ?? null,
            organizationId:
              input.actor?.organizationId ?? ctx?.organizationId ?? null,
            viaPlatform:
              input.actor?.viaPlatform ?? ctx?.organizationType === 'PLATFORM',
          };

    // El token no trae el nombre: se toma de la cuenta (se guarda tal cual
    // estaba en el momento de la acción)
    if (actor?.userId && !actor.fullName) {
      const user = await tx.user.findUnique({
        where: { id: actor.userId },
        select: { fullName: true },
      });
      actor.fullName = user?.fullName ?? null;
    }

    const before = sanitizeAuditData(input.before);
    const after = sanitizeAuditData(input.after);

    // Cabeza de la cadena bajo candado (hasta el fin de la transacción)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY}::bigint)`;
    const head = await tx.auditEvent.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true, hash: true },
    });

    const hashable: AuditHashable = {
      id: randomUUID(),
      seq: head ? Number(head.seq) + 1 : 1,
      // Tras el candado: el orden de `seq` y el de la fecha coinciden
      occurredAt: new Date().toISOString(),
      actorUserId: actor?.userId ?? null,
      actorFullName: truncate(actor?.fullName, 200),
      actorRole: truncate(actor?.role, 50),
      actorOrganizationId: actor?.organizationId ?? null,
      actorViaPlatform: actor?.viaPlatform ?? false,
      sourceApp: input.source?.app ?? ctx?.clientApp ?? 'API',
      sourceIp: truncate(input.source?.ip ?? ctx?.ip ?? null, 64),
      sourceDeviceId: truncate(
        input.source?.deviceId ?? ctx?.deviceId ?? null,
        100,
      ),
      sessionId: truncate(input.sessionId ?? ctx?.sessionId ?? null, 100),
      action: input.action,
      resourceType: truncate(input.resource.type, 100) as string,
      resourceId: truncate(input.resource.id ?? null, 100),
      organizationId: input.organizationId ?? null,
      before,
      after,
      reason: input.reason ?? null,
      correlationId: truncate(
        input.correlationId ?? ctx?.correlationId ?? null,
        100,
      ),
      prevHash: head?.hash ?? null,
    };
    const hash = computeAuditHash(hashable);

    return tx.auditEvent.create({
      data: {
        ...hashable,
        seq: BigInt(hashable.seq),
        occurredAt: new Date(hashable.occurredAt),
        before: (before as Prisma.InputJsonObject | null) ?? Prisma.DbNull,
        after: (after as Prisma.InputJsonObject | null) ?? Prisma.DbNull,
        hash,
      },
    });
  }

  /**
   * Entrada sin otra escritura que la acompañe (p. ej. un inicio de sesión
   * fallido): abre su propia transacción.
   */
  async recordStandalone(input: AuditEventInput): Promise<AuditEvent> {
    return this.prisma.$transaction(
      (tx) => this.record(tx, input),
      AUDIT_TX_OPTIONS,
    );
  }

  /**
   * Ejecuta `work` en una transacción y registra la entrada que describe su
   * resultado en la misma transacción. Atajo para las escrituras de un paso:
   *
   * ```ts
   * return this.audit.transaction(
   *   (tx) => tx.terroir.create({ data }),
   *   (t) => ({ action: AuditAction.TERROIR_CREATED, resource: { type: 'terroir', id: t.id }, organizationId: t.wineryId, after: t }),
   * );
   * ```
   */
  async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    describe: (result: T) => AuditEventInput,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await work(tx);
      await this.record(tx, describe(result));
      return result;
    }, AUDIT_TX_OPTIONS);
  }

  /**
   * Comprueba la cadena entre `from` y `to` (ambos incluidos; por defecto,
   * toda). Detecta contenido cambiado, entradas borradas o intercaladas.
   */
  async verifyChain(
    from?: number,
    to?: number,
  ): Promise<AuditChainVerification> {
    const start = Math.max(1, Math.floor(from ?? 1));
    const end = to !== undefined ? Math.floor(to) : undefined;
    if (end !== undefined && end < start) {
      return { valid: true, checked: 0, firstBrokenSeq: null };
    }

    let expected: { seq: number; prevHash: string | null } = {
      seq: start,
      prevHash: null,
    };
    if (start > 1) {
      const previous = await this.prisma.auditEvent.findUnique({
        where: { seq: BigInt(start - 1) },
        select: { hash: true },
      });
      if (!previous) {
        return { valid: false, checked: 0, firstBrokenSeq: start - 1 };
      }
      expected = { seq: start, prevHash: previous.hash };
    }

    let checked = 0;
    for (;;) {
      const rows = await this.prisma.auditEvent.findMany({
        where: {
          seq: {
            gte: BigInt(expected.seq),
            ...(end !== undefined ? { lte: BigInt(end) } : {}),
          },
        },
        orderBy: { seq: 'asc' },
        take: VERIFY_BATCH_SIZE,
      });
      if (rows.length === 0) break;
      const { brokenSeq, next } = findBrokenLink(
        rows.map(toHashable),
        expected,
      );
      if (brokenSeq !== null) {
        checked += brokenSeq - expected.seq;
        this.logger.error({
          message: `Cadena de la bitácora rota en seq ${brokenSeq}`,
          brokenSeq,
        });
        return { valid: false, checked, firstBrokenSeq: brokenSeq };
      }
      checked += rows.length;
      expected = next;
      if (rows.length < VERIFY_BATCH_SIZE) break;
    }
    return { valid: true, checked, firstBrokenSeq: null };
  }

  /** Forma pública de una entrada (contrato O1 §7). */
  toView(row: AuditEvent): AuditEventView {
    return {
      id: row.id,
      seq: Number(row.seq),
      occurredAt: row.occurredAt.toISOString(),
      actor: {
        userId: row.actorUserId,
        fullName: row.actorFullName,
        role: row.actorRole,
        organizationId: row.actorOrganizationId,
        viaPlatform: row.actorViaPlatform,
      },
      source: {
        app: row.sourceApp as AuditEventView['source']['app'],
        ip: row.sourceIp,
        deviceId: row.sourceDeviceId,
      },
      action: row.action,
      resource: { type: row.resourceType, id: row.resourceId },
      organizationId: row.organizationId,
      before: (row.before as Record<string, unknown> | null) ?? null,
      after: (row.after as Record<string, unknown> | null) ?? null,
      reason: row.reason,
      correlationId: row.correlationId,
      hash: row.hash,
      prevHash: row.prevHash,
    };
  }
}
