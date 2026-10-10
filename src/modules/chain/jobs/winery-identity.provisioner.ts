import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, WineryStatusEnum } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import { CUSTODY_REF_OPERATIONS, intentKeys } from '../chain.constants';
import { KEY_CUSTODY, type KeyCustody } from '../custody/key-custody';
import {
  SYSTEM_REQUESTER,
  WineryIdentityService,
  type ProvisionResult,
} from '../identity/winery-identity.service';
import { ChainIntentsService } from '../tx/chain-intents.service';
import { CHAIN_GATEWAY, type ChainGateway } from './gateway/chain-gateway';

/**
 * Identidad de las bodegas en el worker (contrato O3 §3.1, §3.3 y §3.5):
 * aprovisiona al consumir `winery.activated`, rellena las bodegas `ACTIVE`
 * que no tienen identidad (de una en una) y pausa el contrato de una bodega
 * revocada. Con la cadena deshabilitada no hace nada.
 */
@Injectable()
export class WineryIdentityProvisioner {
  private readonly logger = new Logger(WineryIdentityProvisioner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: WineryIdentityService,
    private readonly intents: ChainIntentsService,
    @Inject(KEY_CUSTODY) private readonly custody: KeyCustody,
    @Inject(CHAIN_GATEWAY) private readonly gateway: ChainGateway,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** `winery.activated`: encadena cuenta y contrato. Reprocesarlo no duplica nada. */
  async provision(wineryId: string): Promise<ProvisionResult | 'SKIPPED'> {
    if (!this.settings.enabled) {
      this.logger.log(
        `Bodega ${wineryId} activada; cadena deshabilitada: sin identidad en la red`,
      );
      return 'SKIPPED';
    }
    return this.prisma.$transaction(async (db) => {
      if (!(await this.lockActive(db, wineryId))) {
        this.logger.warn(
          `Bodega ${wineryId}: no está ACTIVE, no se aprovisiona su identidad`,
        );
        return 'SKIPPED';
      }
      return this.identity.requestProvision(db, wineryId, SYSTEM_REQUESTER, {
        retry: false,
      });
    });
  }

  /**
   * `chain.identity.backfill` (§3.3 paso 4): la siguiente bodega **`ACTIVE`**
   * sin cuenta en esta red, y solo si ninguna otra identidad está a medias
   * (de una en una). Devuelve la bodega aprovisionada o `null`.
   */
  async backfillNext(): Promise<string | null> {
    if (!this.settings.enabled) return null;
    const { network } = this.settings;
    // Sin la cuenta de operaciones en la red, cada identidad fallaría: el
    // relleno espera (lo relanza la confirmación de su `FUND_ACCOUNT`)
    if (!(await this.operationsAccountExists())) {
      this.logger.warn(
        'Relleno de identidades aplazado: la cuenta de operaciones aún no existe en la red',
      );
      return null;
    }
    return this.prisma.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chain-backfill:${network}`}))`;
      const inProgress = await db.chainAccount.count({
        where: { role: 'WINERY', network, status: 'PROVISIONING' },
      });
      if (inProgress > 0) return null;
      const next = await db.winery.findFirst({
        where: {
          certificationStatus: WineryStatusEnum.ACTIVE,
          chainAccounts: { none: { network } },
        },
        orderBy: [{ activatedAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      if (!next || !(await this.lockActive(db, next.id))) return null;
      await this.identity.requestProvision(db, next.id, SYSTEM_REQUESTER, {
        retry: false,
      });
      this.logger.log(`Relleno de identidades: bodega ${next.id}`);
      return next.id;
    });
  }

  /**
   * Bodega `REVOKED` (§3.5): `PAUSE_CONTRACT` firmado por el operador, citando
   * la entrada de bitácora de la revocación. Suspender no toca la red (S-8).
   */
  async pauseRevoked(wineryId: string, auditEventId: string): Promise<boolean> {
    if (!this.settings.enabled) return false;
    const { network } = this.settings;
    return this.prisma.$transaction(async (db) => {
      const contract = await db.nftContract.findFirst({
        where: { wineryId, network, status: 'ACTIVE', paused: false },
        select: { id: true },
      });
      if (!contract) return false;
      const { created } = await this.intents.register(db, {
        kind: 'PAUSE_CONTRACT',
        intentKey: intentKeys.pause(contract.id, auditEventId),
        subject: { type: 'CONTRACT', id: contract.id },
        wineryId,
        params: { auditEventId, cause: 'WINERY_REVOKED' },
        requestedBy: SYSTEM_REQUESTER,
      });
      return created;
    });
  }

  private async operationsAccountExists(): Promise<boolean> {
    try {
      const address = await this.custody.publicKey(CUSTODY_REF_OPERATIONS);
      return (await this.gateway.accountBalance(address)) !== null;
    } catch {
      return false;
    }
  }

  private async lockActive(
    db: Prisma.TransactionClient,
    wineryId: string,
  ): Promise<boolean> {
    const rows = await db.$queryRaw<{ status: string }[]>`
      SELECT certification_status::text AS status FROM wineries
      WHERE id = ${wineryId}::uuid FOR UPDATE`;
    return rows[0]?.status === WineryStatusEnum.ACTIVE;
  }
}
