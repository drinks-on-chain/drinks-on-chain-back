import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import type { PlatformAccountBalanceStatus } from '../chain.constants';
import type {
  PlatformAccountStatusDto,
  PlatformChainAccountsDto,
} from '../dto/chain.dto';
import { explorerAccountUrl } from '../explorer';
import { stroopsToXlm, xlmToStroops } from '../tx/chain-tx.mapper';
import {
  ChainBalanceCache,
  type PlatformAccountRole,
} from './chain-balance-cache';

/** Estado del saldo frente a su mínimo (§2.4). */
export function balanceStatus(
  balanceStroops: bigint | null,
  minStroops: bigint,
): PlatformAccountBalanceStatus {
  if (balanceStroops === null) return 'MISSING';
  return balanceStroops < minStroops ? 'LOW' : 'OK';
}

/**
 * `GET /v1/platform/chain/accounts` (contrato O3 §2.4). Las direcciones las
 * registra el worker al arrancar (`chain_accounts`) y los saldos los lee
 * `chain.balance.check`; la API no tiene claves ni consulta la red.
 */
@Injectable()
export class PlatformAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: ChainBalanceCache,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** Dirección `G…` de una cuenta de la plataforma, o `null` sin configurar. */
  async address(role: PlatformAccountRole): Promise<string | null> {
    const account = await this.prisma.chainAccount.findFirst({
      where: { role, network: this.settings.network, wineryId: null },
      select: { address: true },
    });
    return account?.address ?? null;
  }

  async status(role: PlatformAccountRole): Promise<PlatformAccountStatusDto> {
    const minXlm =
      role === 'OPERATIONS'
        ? this.settings.operationsMinBalanceXlm
        : this.settings.anchorMinBalanceXlm;
    const min = xlmToStroops(minXlm);
    const address = await this.address(role);
    const snapshot = address ? await this.balances.read(role) : null;
    // Una lectura de otra dirección (clave cambiada) no vale
    const reading = snapshot && snapshot.address === address ? snapshot : null;
    const balance =
      reading?.balanceStroops != null ? BigInt(reading.balanceStroops) : null;
    return {
      address,
      explorerUrl: explorerAccountUrl(this.settings.explorerBaseUrl, address),
      balanceXlm: stroopsToXlm(balance ?? 0n),
      minBalanceXlm: stroopsToXlm(min),
      status: balanceStatus(balance, min),
      checkedAt: reading?.checkedAt ?? null,
    };
  }

  async view(): Promise<PlatformChainAccountsDto> {
    const [operations, anchor] = await Promise.all([
      this.status('OPERATIONS'),
      this.status('ANCHOR'),
    ]);
    return {
      network: this.settings.network,
      operations,
      anchor,
      wasmHash: this.settings.wasmHash,
      // La vida del código la lee la tarea de TTL (paso 3.6, §8.3)
      codeTtlDays: null,
    };
  }
}
