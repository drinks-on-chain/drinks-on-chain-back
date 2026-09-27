import { Injectable } from '@nestjs/common';
import { AuditEvent, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import type {
  AuditChainVerification,
  AuditEventView,
} from '@shared/audit/audit.types';
import { parseAuditDate } from './dto/audit-query.dto';

/** Filtros de la bitácora (contrato O1 §7). Fechas: `AAAA-MM-DD` o ISO. */
export interface AuditFilters {
  from?: string;
  to?: string;
  actorId?: string;
  organizationId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
}

export interface AuditPage {
  limit: number;
  offset: number;
}

/** Filas por consulta al exportar (paginación por `seq`, sin `OFFSET`). */
export const AUDIT_EXPORT_BATCH_SIZE = 1000;

/**
 * Consulta de la bitácora (AUD-03, AUD-04): lista con filtros y orden
 * descendente por `seq`, recorrido por lotes para la exportación CSV,
 * verificación de la cadena por fechas y bitácora de una organización.
 * Escribir sigue siendo cosa de `AuditService` (src/shared/audit).
 */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** `where` de Prisma para los filtros. */
  where(filters: AuditFilters): Prisma.AuditEventWhereInput {
    const from = parseAuditDate(filters.from, 'from');
    const to = parseAuditDate(filters.to, 'to');
    return {
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(filters.actorId ? { actorUserId: filters.actorId } : {}),
      ...(filters.organizationId
        ? { organizationId: filters.organizationId }
        : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
    };
  }

  /**
   * Lo que atañe a una organización (AUD-04): lo que la afecta (también lo
   * que hizo en ella el back office) y lo que hicieron sus miembros desde ella.
   */
  organizationWhere(
    organizationId: string,
    filters: Omit<AuditFilters, 'organizationId'>,
  ): Prisma.AuditEventWhereInput {
    return {
      AND: [
        this.where(filters),
        {
          OR: [{ organizationId }, { actorOrganizationId: organizationId }],
        },
      ],
    };
  }

  /** Página de entradas, de la más reciente a la más antigua. */
  async list(
    where: Prisma.AuditEventWhereInput,
    page: AuditPage,
  ): Promise<{ items: AuditEventView[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { seq: 'desc' },
        take: page.limit,
        skip: page.offset,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    return { items: rows.map((row) => this.audit.toView(row)), total };
  }

  count(where: Prisma.AuditEventWhereInput): Promise<number> {
    return this.prisma.auditEvent.count({ where });
  }

  /** Las `n` entradas más recientes (tablero). */
  async recent(n: number): Promise<AuditEventView[]> {
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: { seq: 'desc' },
      take: n,
    });
    return rows.map((row) => this.audit.toView(row));
  }

  /**
   * Recorre las entradas en orden cronológico (`seq` ascendente) por lotes,
   * sin cargar la exportación entera en memoria.
   */
  async *batches(
    where: Prisma.AuditEventWhereInput,
    batchSize = AUDIT_EXPORT_BATCH_SIZE,
  ): AsyncGenerator<AuditEventView[]> {
    let after: bigint | null = null;
    for (;;) {
      const rows: AuditEvent[] = await this.prisma.auditEvent.findMany({
        where:
          after === null ? where : { AND: [where, { seq: { gt: after } }] },
        orderBy: { seq: 'asc' },
        take: batchSize,
      });
      if (rows.length === 0) return;
      yield rows.map((row) => this.audit.toView(row));
      if (rows.length < batchSize) return;
      after = rows[rows.length - 1].seq;
    }
  }

  /**
   * Verifica la cadena de las entradas entre dos fechas (ambas incluidas; sin
   * ellas, toda). Traduce las fechas a `seq` y usa `AuditService.verifyChain`,
   * que además comprueba el enlace con la entrada anterior al tramo.
   */
  async verify(range: {
    from?: string;
    to?: string;
  }): Promise<AuditChainVerification> {
    const from = parseAuditDate(range.from, 'from');
    const to = parseAuditDate(range.to, 'to');
    const empty: AuditChainVerification = {
      valid: true,
      checked: 0,
      firstBrokenSeq: null,
    };

    let fromSeq: number | undefined;
    if (from) {
      const first = await this.prisma.auditEvent.findFirst({
        where: { occurredAt: { gte: from } },
        orderBy: { seq: 'asc' },
        select: { seq: true },
      });
      if (!first) return empty;
      fromSeq = Number(first.seq);
    }
    let toSeq: number | undefined;
    if (to) {
      const last = await this.prisma.auditEvent.findFirst({
        where: { occurredAt: { lte: to } },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      if (!last) return empty;
      toSeq = Number(last.seq);
    }
    return this.audit.verifyChain(fromSeq, toSeq);
  }
}
