import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  ChainBalanceCache,
  type PlatformAccountRole,
} from '../accounts/chain-balance-cache';
import { balanceStatus } from '../accounts/platform-accounts.service';
import { ChainAlertsWriter } from '../alerts/chain-alerts.writer';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import {
  CUSTODY_REF_ANCHOR,
  CUSTODY_REF_OPERATIONS,
  FRIENDBOT_NETWORKS,
  intentKeys,
  type PlatformAccountBalanceStatus,
} from '../chain.constants';
import { KEY_CUSTODY, type KeyCustody } from '../custody/key-custody';
import { ChainIntentsService } from '../tx/chain-intents.service';
import { stroopsToXlm, xlmToStroops } from '../tx/chain-tx.mapper';
import { CHAIN_GATEWAY, type ChainGateway } from './gateway/chain-gateway';

const PLATFORM_ACCOUNTS: { role: PlatformAccountRole; ref: string }[] = [
  { role: 'OPERATIONS', ref: CUSTODY_REF_OPERATIONS },
  { role: 'ANCHOR', ref: CUSTODY_REF_ANCHOR },
];

export interface PlatformBalance {
  role: PlatformAccountRole;
  address: string;
  status: PlatformAccountBalanceStatus;
}

/**
 * Cuentas de la plataforma en el worker (contrato O3 §2.1 y §11): registra
 * sus direcciones en `chain_accounts` (la API no tiene claves), lee sus
 * saldos (`chain.balance.check`), abre o cierra la alerta `LOW_BALANCE` y,
 * solo en `TESTNET` y `LOCAL`, pide Friendbot (`chain.testnet.fund`).
 */
@Injectable()
export class PlatformAccountsSync {
  private readonly logger = new Logger(PlatformAccountsSync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: ChainBalanceCache,
    private readonly alerts: ChainAlertsWriter,
    private readonly intents: ChainIntentsService,
    @Inject(KEY_CUSTODY) private readonly custody: KeyCustody,
    @Inject(CHAIN_GATEWAY) private readonly gateway: ChainGateway,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** Escribe en la base la dirección pública de operaciones y de anclaje. */
  async syncAddresses(): Promise<
    { role: PlatformAccountRole; address: string }[]
  > {
    if (!this.settings.enabled) return [];
    const { network } = this.settings;
    const synced: { role: PlatformAccountRole; address: string }[] = [];
    for (const { role, ref } of PLATFORM_ACCOUNTS) {
      let address: string;
      try {
        address = await this.custody.ensureKey(ref);
      } catch (error) {
        this.logger.warn(
          `Cuenta de ${role} sin clave en el custodio: ${error instanceof Error ? error.message : 'error'}`,
        );
        continue;
      }
      await this.prisma.chainAccount.upsert({
        where: { network_custodyKeyRef: { network, custodyKeyRef: ref } },
        create: {
          role,
          network,
          custodyKeyRef: ref,
          address,
          status: 'ACTIVE',
        },
        update: { address, status: 'ACTIVE' },
      });
      synced.push({ role, address });
    }
    return synced;
  }

  /** `chain.balance.check`: saldos, caché para la API y alerta de saldo bajo. */
  async checkBalances(): Promise<PlatformBalance[]> {
    const results: PlatformBalance[] = [];
    for (const { role, address } of await this.syncAddresses()) {
      const balance = await this.gateway.accountBalance(address);
      await this.balances.write(role, {
        address,
        balanceStroops: balance?.toString() ?? null,
        checkedAt: new Date().toISOString(),
      });
      const minXlm =
        role === 'OPERATIONS'
          ? this.settings.operationsMinBalanceXlm
          : this.settings.anchorMinBalanceXlm;
      const status = balanceStatus(balance, xlmToStroops(minXlm));
      const subject = { subjectType: 'PLATFORM_ACCOUNT', subjectId: role };
      await this.prisma.$transaction(async (db) => {
        if (status === 'OK') {
          await this.alerts.resolveAuto(
            db,
            { code: 'LOW_BALANCE', ...subject },
            'El saldo volvió a superar el mínimo',
          );
          return;
        }
        await this.alerts.raise(db, {
          code: 'LOW_BALANCE',
          level: role === 'OPERATIONS' ? 'CRITICAL' : 'WARNING',
          ...subject,
          message:
            status === 'MISSING'
              ? `La cuenta de ${role} no existe en la red ${this.settings.network}`
              : `El saldo de la cuenta de ${role} está por debajo del mínimo`,
          expected: { minBalanceXlm: stroopsToXlm(xlmToStroops(minXlm)) },
          actual: { balanceXlm: stroopsToXlm(balance ?? 0n), status },
        });
      });
      results.push({ role, address, status });
    }
    return results;
  }

  /**
   * `chain.testnet.fund`: una intención `FUND_ACCOUNT` por cuenta y día si
   * falta o está baja. Nunca en la red pública.
   */
  async fundIfNeeded(): Promise<PlatformAccountRole[]> {
    if (
      !this.settings.enabled ||
      !FRIENDBOT_NETWORKS.includes(this.settings.network)
    ) {
      return [];
    }
    const day = new Date().toISOString().slice(0, 10);
    const requested: PlatformAccountRole[] = [];
    for (const { role, status } of await this.checkBalances()) {
      if (status === 'OK') continue;
      const { created } = await this.prisma.$transaction((db) =>
        this.intents.register(db, {
          kind: 'FUND_ACCOUNT',
          intentKey: intentKeys.fund(role, day),
          subject: { type: 'PLATFORM', id: role },
          params: { role, reason: status },
        }),
      );
      if (created) requested.push(role);
    }
    return requested;
  }
}
