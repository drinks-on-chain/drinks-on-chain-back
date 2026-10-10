import { Inject, Injectable, Logger } from '@nestjs/common';
import type { xdr } from '@stellar/stellar-sdk';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../../chain.config';
import { intentKeys } from '../../chain.constants';
import { ChainIntentsService } from '../../tx/chain-intents.service';
import { CODE_TTL_CURSOR } from '../../ttl/code-ttl';
import {
  codeKey,
  contractTtlKeys,
  daysLeft,
  keyXdr,
  type MintedRange,
  type NamedLedgerKey,
} from '../../ttl/ttl-keys';
import { CHAIN_GATEWAY, type ChainGateway } from '../gateway/chain-gateway';

export interface TtlEntry {
  name: string;
  key: xdr.LedgerKey;
  keyXdr: string;
  /** `null`: la entrada no existe en la red (nada que extender). */
  liveUntilLedger: number | null;
  daysLeft: number | null;
  /** Existe pero su vida ya pasó: hay que restaurarla antes de usarla. */
  archived: boolean;
}

export interface TtlReading {
  latestLedger: number;
  entries: TtlEntry[];
}

export interface TtlRunResult {
  /** Días de vida del código (`null` si no se pudo leer o no hay código). */
  codeDays: number | null;
  contracts: number;
  /** `intentKey` de las extensiones registradas en esta pasada. */
  requested: string[];
  errors: number;
}

/** Extensiones por sujeto y día: freno si algo no llega nunca al umbral. */
const MAX_EXTENSIONS_PER_DAY = 6;

/** Fecha (UTC) que entra en la clave de la intención. */
const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Vida del almacenamiento (contrato O3 §8.3, CHN-13). Lee el TTL de las
 * entradas de cada contrato y del código compartido y registra una intención
 * `EXTEND_TTL` por contrato (y otra, aparte, para el código) cuando alguna
 * baja de `CHAIN_TTL_EXTEND_BELOW_DAYS`. No firma nada: el firmante valida la
 * intención y vuelve a calcular las claves él mismo.
 */
@Injectable()
export class ChainTtlService {
  private readonly logger = new Logger(ChainTtlService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: ChainIntentsService,
    @Inject(CHAIN_GATEWAY) private readonly gateway: ChainGateway,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** Claves de datos de un contrato, calculadas de la base (§8.3 corregido). */
  async contractKeys(contractId: string): Promise<NamedLedgerKey[]> {
    const contract = await this.prisma.nftContract.findUnique({
      where: { id: contractId },
      select: {
        address: true,
        chainAccount: { select: { address: true } },
        collections: { select: { mints: { select: { ranges: true } } } },
        tokens: {
          where: { OR: [{ status: 'BURNED' }, { onchainBurned: true }] },
          select: { tokenId: true },
        },
      },
    });
    if (!contract?.address || !contract.chainAccount.address) return [];
    const ranges = contract.collections.flatMap((collection) =>
      collection.mints.flatMap((mint) =>
        Array.isArray(mint.ranges)
          ? (mint.ranges as unknown as MintedRange[])
          : [],
      ),
    );
    return contractTtlKeys({
      contractAddress: contract.address,
      wineryAccount: contract.chainAccount.address,
      ranges,
      burnedIds: contract.tokens.map((token) => token.tokenId),
    });
  }

  private async read(keys: NamedLedgerKey[]): Promise<TtlReading> {
    const { latestLedger, liveUntil } = await this.gateway.entriesTtl(
      keys.map((k) => k.key),
    );
    return {
      latestLedger,
      entries: keys.map(({ name, key }) => {
        const encoded = keyXdr(key);
        const until = liveUntil.get(encoded) ?? null;
        return {
          name,
          key,
          keyXdr: encoded,
          liveUntilLedger: until,
          daysLeft: daysLeft(until, latestLedger),
          archived: until !== null && until < latestLedger,
        };
      }),
    };
  }

  async readContract(contractId: string): Promise<TtlReading> {
    return this.read(await this.contractKeys(contractId));
  }

  /** Vida del código; deja la lectura para la API (`codeTtlDays`, §2.4). */
  async readCode(): Promise<TtlReading | null> {
    const { wasmHash, network } = this.settings;
    if (!wasmHash) return null;
    const reading = await this.read([{ name: 'code', key: codeKey(wasmHash) }]);
    const [code] = reading.entries;
    if (code.liveUntilLedger !== null) {
      const data = {
        cursor: String(code.liveUntilLedger),
        lastLedger: reading.latestLedger,
        updatedAt: new Date(),
      };
      await this.prisma.chainCursor.upsert({
        where: { network_name: { network, name: CODE_TTL_CURSOR } },
        create: { network, name: CODE_TTL_CURSOR, ...data },
        update: data,
      });
    }
    return reading;
  }

  /** Entradas vivas a las que les queda menos del umbral. */
  below(reading: TtlReading, days: number): TtlEntry[] {
    return reading.entries.filter(
      (entry) => entry.daysLeft !== null && entry.daysLeft < days,
    );
  }

  /**
   * `chain.ttl.extend` (diaria, y tras cada emisión): una intención por
   * contrato con algo que extender y otra para el código. Repetirla mientras
   * hay una en curso no registra otra.
   */
  async run(now: Date = new Date()): Promise<TtlRunResult> {
    const result: TtlRunResult = {
      codeDays: null,
      contracts: 0,
      requested: [],
      errors: 0,
    };
    if (!this.settings.enabled) return result;
    const { network, wasmHash, ttlExtendBelowDays } = this.settings;
    const day = dayOf(now);

    try {
      const code = await this.readCode();
      const entry = code?.entries[0];
      result.codeDays = entry?.daysLeft ?? null;
      if (wasmHash && code && this.below(code, ttlExtendBelowDays).length > 0) {
        const key = await this.nextKey(intentKeys.ttlCode(wasmHash, day), (n) =>
          intentKeys.ttlCode(wasmHash, day, n),
        );
        if (key) {
          await this.prisma.$transaction((db) =>
            this.intents.register(db, {
              kind: 'EXTEND_TTL',
              intentKey: key,
              subject: { type: 'PLATFORM', id: 'CODE' },
              params: { target: 'CODE', wasmHash, day },
            }),
          );
          result.requested.push(key);
        }
      }
    } catch (error) {
      result.errors += 1;
      this.warn('el código', error);
    }

    const contracts = await this.prisma.nftContract.findMany({
      where: { network, status: 'ACTIVE', address: { not: null } },
      select: { id: true, wineryId: true },
      orderBy: { createdAt: 'asc' },
    });
    result.contracts = contracts.length;
    for (const contract of contracts) {
      try {
        const reading = await this.readContract(contract.id);
        if (this.below(reading, ttlExtendBelowDays).length === 0) continue;
        const key = await this.nextKey(
          intentKeys.ttlContract(contract.id, day),
          (n) => intentKeys.ttlContract(contract.id, day, n),
        );
        if (!key) continue;
        await this.prisma.$transaction((db) =>
          this.intents.register(db, {
            kind: 'EXTEND_TTL',
            intentKey: key,
            subject: { type: 'CONTRACT', id: contract.id },
            wineryId: contract.wineryId,
            params: { target: 'CONTRACT', contractId: contract.id, day },
          }),
        );
        result.requested.push(key);
      } catch (error) {
        result.errors += 1;
        this.warn(`el contrato ${contract.id}`, error);
      }
    }
    this.logger.log({
      message: 'Vida del almacenamiento revisada',
      ...result,
      requested: result.requested.length,
    });
    return result;
  }

  /**
   * Clave de la siguiente extensión del día: `null` si ya hay una en curso
   * (o sin resolver) o si el día agotó sus extensiones. Tras una confirmada
   * puede hacer falta otra (una emisión posterior deja entradas nuevas).
   */
  private async nextKey(
    base: string,
    keyOf: (n: number) => string,
  ): Promise<string | null> {
    const today = await this.prisma.chainTransaction.findMany({
      where: { kind: 'EXTEND_TTL', intentKey: { startsWith: base } },
      select: { status: true },
    });
    if (today.some((tx) => tx.status !== 'CONFIRMED')) return null;
    if (today.length >= MAX_EXTENSIONS_PER_DAY) return null;
    return keyOf(today.length);
  }

  private warn(what: string, error: unknown): void {
    this.logger.warn(
      `No se pudo revisar el TTL de ${what}: ${error instanceof Error ? error.message.slice(0, 200) : 'error'}`,
    );
  }
}
