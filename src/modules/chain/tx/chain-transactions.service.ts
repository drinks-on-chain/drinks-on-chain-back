import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import { NON_ABANDONABLE_CHAIN_TX_KINDS } from '../chain.constants';
import type {
  ChainTransactionDto,
  ChainTransactionsQueryDto,
} from '../dto/chain.dto';
import { ChainIntentsService } from './chain-intents.service';
import { toChainTransaction } from './chain-tx.mapper';

const conflict = (
  code: string,
  message: string,
  meta: Record<string, unknown>,
): AppException =>
  new AppException(HttpStatus.CONFLICT, code, message, [
    { field: null, message, meta },
  ]);

const notFound = (): AppException =>
  new AppException(
    HttpStatus.NOT_FOUND,
    ErrorCode.CHN_TX_NOT_FOUND,
    'La transacción no existe',
  );

/**
 * Back office · transacciones de la cadena (contrato O3 §2.4). Solo lee y
 * cambia estado en la base: reintentar deja la transacción `PENDING` y el
 * worker la reconstruye; ninguna ruta firma ni espera a la red.
 */
@Injectable()
export class ChainTransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly intents: ChainIntentsService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  async list(
    query: ChainTransactionsQueryDto,
  ): Promise<Paginated<ChainTransactionDto>> {
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = new Date(query.from);
    if (query.to) createdAt.lte = new Date(query.to);
    const where: Prisma.ChainTransactionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.wineryId ? { wineryId: query.wineryId } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.from || query.to ? { createdAt } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.chainTransaction.findMany({
        where,
        include: { attemptsLog: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.chainTransaction.count({ where }),
    ]);
    return toPage(
      rows.map((row) => toChainTransaction(row, this.settings.explorerBaseUrl)),
      total,
      query,
    );
  }

  async detail(id: string): Promise<ChainTransactionDto> {
    const row = await this.prisma.chainTransaction.findUnique({
      where: { id },
      include: { attemptsLog: true },
    });
    if (!row) throw notFound();
    return toChainTransaction(row, this.settings.explorerBaseUrl);
  }

  /** `FAILED → PENDING`; otro estado (o abandonada) → 409 `CHN_TX_NOT_RETRYABLE`. */
  async retry(
    id: string,
    reason: string,
    user: AuthenticatedUser,
  ): Promise<ChainTransactionDto> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.status !== 'FAILED' || row.abandonedAt !== null) {
        throw conflict(
          ErrorCode.CHN_TX_NOT_RETRYABLE,
          row.abandonedAt !== null
            ? 'La transacción se abandonó: no se reintenta'
            : `Solo se reintenta una transacción fallida; esta está ${row.status}`,
          { status: row.status, abandoned: row.abandonedAt !== null },
        );
      }
      await this.intents.requeue(tx, id);
      await this.audit.record(tx, {
        action: AuditAction.CHAIN_TX_RETRIED,
        resource: { type: 'chain_transaction', id },
        organizationId: row.wineryId,
        before: { status: row.status, lastError: row.lastError },
        after: { status: 'PENDING', kind: row.kind, intentKey: row.intentKey },
        reason,
        actor: { userId: user.id },
      });
    }, AUDIT_TX_OPTIONS);
    return this.detail(id);
  }

  /**
   * Deja constancia de que una transacción fallida no se reintentará. Las
   * emisiones, los anclajes y la identidad de una bodega deben terminar.
   */
  async abandon(
    id: string,
    reason: string,
    user: AuthenticatedUser,
  ): Promise<ChainTransactionDto> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, id);
      const kindBlocked = (
        NON_ABANDONABLE_CHAIN_TX_KINDS as readonly string[]
      ).includes(row.kind);
      if (kindBlocked || row.status !== 'FAILED' || row.abandonedAt !== null) {
        throw conflict(
          ErrorCode.CHN_TX_NOT_ABANDONABLE,
          kindBlocked
            ? `Una transacción ${row.kind} debe terminar: no se abandona`
            : row.abandonedAt !== null
              ? 'La transacción ya estaba abandonada'
              : `Solo se abandona una transacción fallida; esta está ${row.status}`,
          { kind: row.kind, status: row.status },
        );
      }
      const actor = await tx.user.findUnique({
        where: { id: user.id },
        select: { fullName: true },
      });
      await tx.chainTransaction.update({
        where: { id },
        data: {
          abandonedAt: new Date(),
          abandonedBy: actor?.fullName ?? user.id,
          abandonReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.CHAIN_TX_ABANDONED,
        resource: { type: 'chain_transaction', id },
        organizationId: row.wineryId,
        before: { status: row.status, abandoned: false },
        after: { abandoned: true, kind: row.kind, intentKey: row.intentKey },
        reason,
        actor: { userId: user.id },
      });
    }, AUDIT_TX_OPTIONS);
    return this.detail(id);
  }

  private async lock(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM chain_transactions WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.chainTransaction.findUnique({ where: { id } });
    if (!row) throw notFound();
    return row;
  }
}
