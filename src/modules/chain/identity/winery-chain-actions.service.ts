import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { NftContract, Prisma, WineryStatusEnum } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import { intentKeys } from '../chain.constants';
import type {
  WineryChainAccountViewDto,
  WineryChainIdentityDto,
} from '../dto/chain.dto';
import { ChainIntentsService } from '../tx/chain-intents.service';
import { OPEN_TX_STATUSES } from '../tx/chain-tx.state';
import { WineryIdentityService } from './winery-identity.service';

type Db = Prisma.TransactionClient;

const conflict = (
  code: string,
  message: string,
  meta?: Record<string, unknown>,
): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    code,
    message,
    meta ? [{ field: null, message, meta }] : undefined,
  );

const wineryNotFound = (): AppException =>
  new AppException(
    HttpStatus.NOT_FOUND,
    ErrorCode.ORG_NOT_FOUND,
    'Bodega no encontrada',
  );

/**
 * Back office y ERP · identidad de una bodega en la red (contrato O3 §3.1,
 * §3.4 y §3.5). Las acciones registran intenciones y su entrada de bitácora
 * en una transacción de base de datos y responden `202` con la identidad;
 * el worker firma y envía.
 */
@Injectable()
export class WineryChainActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly identity: WineryIdentityService,
    private readonly intents: ChainIntentsService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** `GET …/chain-account` (ERP y plataforma). */
  async accountView(wineryId: string): Promise<WineryChainAccountViewDto> {
    const exists = await this.prisma.winery.count({ where: { id: wineryId } });
    if (exists === 0) throw wineryNotFound();
    return this.identity.accountView(wineryId);
  }

  /** Relanza el aprovisionamiento de una identidad `FAILED` o `NOT_PROVISIONED`. */
  async provision(
    wineryId: string,
    reason: string,
    user: AuthenticatedUser,
  ): Promise<WineryChainIdentityDto> {
    this.assertEnabled();
    return this.prisma.$transaction(async (db) => {
      const status = await this.lockWinery(db, wineryId);
      if (status !== WineryStatusEnum.ACTIVE) {
        throw conflict(
          ErrorCode.TOK_WINERY_NOT_ACTIVE,
          `La bodega está ${status}: su identidad en la red solo se crea con la bodega activa`,
          { status },
        );
      }
      const before = await this.identity.view(wineryId, db);
      const result = await this.identity.requestProvision(
        db,
        wineryId,
        await this.requester(db, user),
        { retry: true },
      );
      if (result === 'ALREADY_ACTIVE') {
        throw conflict(
          ErrorCode.CHN_IDENTITY_ALREADY_ACTIVE,
          'La bodega ya tiene su identidad en la red',
        );
      }
      await this.audit.record(db, {
        action: AuditAction.WINERY_CHAIN_PROVISION_RETRIED,
        resource: { type: 'winery', id: wineryId },
        organizationId: wineryId,
        before: { status: before.status, lastError: before.lastError },
        after: { status: 'PROVISIONING', result },
        reason,
        actor: { userId: user.id },
      });
      return this.identity.view(wineryId, db);
    }, AUDIT_TX_OPTIONS);
  }

  /** `PAUSE_CONTRACT` (incidente): firmado por el operador. */
  pause(
    wineryId: string,
    reason: string,
    user: AuthenticatedUser,
  ): Promise<WineryChainIdentityDto> {
    return this.togglePause(wineryId, reason, user, true);
  }

  /** `UNPAUSE_CONTRACT`: firmado con la clave custodiada de la bodega. */
  unpause(
    wineryId: string,
    reason: string,
    user: AuthenticatedUser,
  ): Promise<WineryChainIdentityDto> {
    return this.togglePause(wineryId, reason, user, false);
  }

  private async togglePause(
    wineryId: string,
    reason: string,
    user: AuthenticatedUser,
    pause: boolean,
  ): Promise<WineryChainIdentityDto> {
    this.assertEnabled();
    const kind = pause ? 'PAUSE_CONTRACT' : 'UNPAUSE_CONTRACT';
    return this.prisma.$transaction(async (db) => {
      await this.lockWinery(db, wineryId);
      const contract = await this.activeContract(db, wineryId);
      if (!contract) {
        const { status } = await this.identity.view(wineryId, db);
        throw pause
          ? conflict(
              ErrorCode.TOK_WINERY_CHAIN_NOT_READY,
              'La bodega no tiene un contrato desplegado en la red',
              { status },
            )
          : conflict(
              ErrorCode.CHN_CONTRACT_NOT_PAUSED,
              'La bodega no tiene un contrato pausado en la red',
            );
      }
      const inProgress = await db.chainTransaction.count({
        where: {
          kind,
          subjectType: 'CONTRACT',
          subjectId: contract.id,
          status: { in: [...OPEN_TX_STATUSES] },
        },
      });
      if (pause && (contract.paused || inProgress > 0)) {
        throw conflict(
          ErrorCode.CHN_CONTRACT_ALREADY_PAUSED,
          contract.paused
            ? 'El contrato ya está pausado en la red'
            : 'Ya hay una pausa de este contrato en curso',
        );
      }
      if (!pause && (!contract.paused || inProgress > 0)) {
        throw conflict(
          ErrorCode.CHN_CONTRACT_NOT_PAUSED,
          contract.paused
            ? 'Ya hay una reanudación de este contrato en curso'
            : 'El contrato no está pausado en la red',
        );
      }
      const entry = await this.audit.record(db, {
        action: pause
          ? AuditAction.CHAIN_CONTRACT_PAUSED
          : AuditAction.CHAIN_CONTRACT_UNPAUSED,
        resource: { type: 'nft_contract', id: contract.id },
        organizationId: wineryId,
        before: { paused: contract.paused },
        after: { requested: kind, contract: contract.address },
        reason,
        actor: { userId: user.id },
      });
      // La intención cita su entrada de bitácora: el firmante la exige (§2.2)
      await this.intents.register(db, {
        kind,
        intentKey: (pause ? intentKeys.pause : intentKeys.unpause)(
          contract.id,
          entry.id,
        ),
        subject: { type: 'CONTRACT', id: contract.id },
        wineryId,
        params: { auditEventId: entry.id },
        requestedBy: await this.requester(db, user),
      });
      return this.identity.view(wineryId, db);
    }, AUDIT_TX_OPTIONS);
  }

  private activeContract(
    db: Db,
    wineryId: string,
  ): Promise<NftContract | null> {
    return db.nftContract.findFirst({
      where: {
        wineryId,
        network: this.settings.network,
        status: 'ACTIVE',
        address: { not: null },
      },
    });
  }

  private async lockWinery(db: Db, wineryId: string): Promise<string> {
    const rows = await db.$queryRaw<{ status: string }[]>`
      SELECT certification_status::text AS status FROM wineries
      WHERE id = ${wineryId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw wineryNotFound();
    return rows[0].status;
  }

  private async requester(db: Db, user: AuthenticatedUser) {
    const account = await db.user.findUnique({
      where: { id: user.id },
      select: { fullName: true },
    });
    return {
      userId: user.id,
      fullName: account?.fullName ?? null,
      source: 'API' as const,
    };
  }

  private assertEnabled(): void {
    if (!this.settings.enabled) {
      throw conflict(
        ErrorCode.CHN_DISABLED,
        'La cadena no está configurada en este entorno',
      );
    }
  }
}
