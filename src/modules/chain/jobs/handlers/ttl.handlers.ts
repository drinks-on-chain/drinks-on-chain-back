import { Inject, Injectable } from '@nestjs/common';
import { ChainTransaction, Prisma } from '@prisma/client';
import { xdr } from '@stellar/stellar-sdk';
import { CHAIN_SETTINGS, type ChainSettings } from '../../chain.config';
import { LEDGERS_PER_DAY, TTL_EXTEND_TO_DAYS } from '../../chain.constants';
import {
  ArchivedEntriesFailure,
  IntentRejected,
} from '../../tx/chain-tx.errors';
import { keyXdr, ledgerKeyOwner } from '../../ttl/ttl-keys';
import type {
  IntentEnv,
  IntentHandler,
  PreparedIntent,
} from '../signer/intent-handler';
import { ChainTtlService, type TtlReading } from '../ttl/chain-ttl.service';

type Db = Prisma.TransactionClient;

type ExtendPlan =
  { target: 'CODE' } | { target: 'CONTRACT'; contractId: string };

/** Claves por transacción de mantenimiento (holgura bajo el tope de la huella). */
const MAX_KEYS_PER_TX = 60;

/**
 * `EXTEND_TTL` (contrato O3 §8.3; DS-12, P-SC-4, P-SC-6): lleva a 120 días
 * las entradas a las que les quede menos de `CHAIN_TTL_EXTEND_BELOW_DAYS`.
 * La intención solo dice **qué** se mantiene (un contrato o el código); las
 * claves las calcula el manejador de la base y su vida la lee de la red al
 * preparar. El código va en su propia transacción, con su tope de comisión.
 * Paga operaciones; no hay autorización de Soroban.
 */
@Injectable()
export class ExtendTtlHandler implements IntentHandler<ExtendPlan, TtlReading> {
  readonly kind = 'EXTEND_TTL' as const;
  readonly source = 'OPERATIONS' as const;

  constructor(
    private readonly ttl: ChainTtlService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  async validate(db: Db, transaction: ChainTransaction): Promise<ExtendPlan> {
    const params = (transaction.intent ?? {}) as {
      target?: unknown;
      contractId?: unknown;
      wasmHash?: unknown;
    };
    if (params.target === 'CODE') {
      if (
        transaction.subjectType !== 'PLATFORM' ||
        transaction.subjectId !== 'CODE' ||
        !this.settings.wasmHash ||
        params.wasmHash !== this.settings.wasmHash ||
        !transaction.intentKey.startsWith('ttl:code:')
      ) {
        throw new IntentRejected(
          'la intención no es del código vigente del contrato NFT',
        );
      }
      return { target: 'CODE' };
    }
    const contractId = transaction.subjectId;
    if (
      params.target !== 'CONTRACT' ||
      transaction.subjectType !== 'CONTRACT' ||
      params.contractId !== contractId ||
      !transaction.intentKey.startsWith(`ttl:${contractId}:`)
    ) {
      throw new IntentRejected('la intención no describe qué mantener');
    }
    const contract = await db.nftContract.findUnique({
      where: { id: contractId },
      select: { address: true, status: true, network: true, wineryId: true },
    });
    if (
      !contract?.address ||
      contract.status !== 'ACTIVE' ||
      contract.network !== transaction.network ||
      contract.wineryId !== transaction.wineryId
    ) {
      throw new IntentRejected('la bodega no tiene un contrato vigente');
    }
    return { target: 'CONTRACT', contractId };
  }

  private read(plan: ExtendPlan): Promise<TtlReading | null> {
    return plan.target === 'CODE'
      ? this.ttl.readCode()
      : this.ttl.readContract(plan.contractId);
  }

  async prepare(plan: ExtendPlan): Promise<PreparedIntent> {
    const reading = await this.read(plan);
    const due = reading
      ? this.ttl.below(reading, this.settings.ttlExtendBelowDays)
      : [];
    if (due.length === 0) {
      return {
        type: 'ALREADY_DONE',
        note: 'Ninguna entrada baja del umbral de extensión',
      };
    }
    const archived = due.filter((entry) => entry.archived);
    if (archived.length > 0) {
      // No se puede extender lo archivado: primero `RESTORE_ENTRIES` (§2.3)
      throw new ArchivedEntriesFailure(archived.map((entry) => entry.keyXdr));
    }
    return {
      type: 'FOOTPRINT',
      action: 'EXTEND',
      // Las más urgentes primero; el resto, en la pasada del día siguiente
      keys: due
        .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
        .slice(0, MAX_KEYS_PER_TX)
        .map((entry) => entry.key),
      extendTo: TTL_EXTEND_TO_DAYS * LEDGERS_PER_DAY,
      ...(plan.target === 'CODE'
        ? { maxFeeStroops: this.settings.codeTtlMaxFeeStroops }
        : {}),
    };
  }

  /** Lectura de vuelta: deja al día `codeTtlDays` tras extender el código. */
  async verify(transaction: ChainTransaction): Promise<TtlReading> {
    const params = (transaction.intent ?? {}) as { target?: unknown };
    const reading = await this.read(
      params.target === 'CODE'
        ? { target: 'CODE' }
        : { target: 'CONTRACT', contractId: transaction.subjectId },
    );
    return reading ?? { latestLedger: 0, entries: [] };
  }
}

interface RestorePlan {
  keys: xdr.LedgerKey[];
}

/**
 * `RESTORE_ENTRIES` (contrato O3 §2.3 y §8.3): restaura entradas archivadas
 * que una simulación pidió (`CHN_ARCHIVED_ENTRY`). Las claves llegan de esa
 * simulación, así que se validan una a una: solo entradas de datos de un
 * contrato propio de esta red o el código vigente; cualquier otra rechaza la
 * intención entera. Paga operaciones.
 */
@Injectable()
export class RestoreEntriesHandler implements IntentHandler<RestorePlan> {
  readonly kind = 'RESTORE_ENTRIES' as const;
  readonly source = 'OPERATIONS' as const;

  constructor(
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  async validate(db: Db, transaction: ChainTransaction): Promise<RestorePlan> {
    const params = (transaction.intent ?? {}) as { ledgerKeys?: unknown };
    const raw = params.ledgerKeys;
    if (
      !transaction.intentKey.startsWith('restore:') ||
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > MAX_KEYS_PER_TX ||
      raw.some((key) => typeof key !== 'string')
    ) {
      throw new IntentRejected('la intención no trae las entradas a restaurar');
    }
    const keys: xdr.LedgerKey[] = [];
    const contracts = new Set<string>();
    for (const encoded of raw as string[]) {
      let key: xdr.LedgerKey;
      try {
        key = xdr.LedgerKey.fromXDR(encoded, 'base64');
      } catch {
        throw new IntentRejected('una de las claves no es un LedgerKey');
      }
      const owner = ledgerKeyOwner(key);
      if (!owner) {
        throw new IntentRejected(
          'solo se restauran entradas de contratos o el código',
        );
      }
      if (owner.type === 'CODE') {
        if (owner.wasmHash !== this.settings.wasmHash) {
          throw new IntentRejected('el código a restaurar no es el vigente');
        }
      } else {
        contracts.add(owner.address);
      }
      keys.push(key);
    }
    if (contracts.size > 0) {
      const known = await db.nftContract.count({
        where: {
          network: transaction.network,
          address: { in: [...contracts] },
        },
      });
      if (known !== contracts.size) {
        throw new IntentRejected(
          'una de las entradas no es de un contrato de la plataforma',
        );
      }
    }
    return { keys };
  }

  async prepare(
    plan: RestorePlan,
    _transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    const { latestLedger, liveUntil } = await env.gateway.entriesTtl(plan.keys);
    // Las que el RPC devuelve con vida por delante no necesitan nada
    const pending = plan.keys.filter((key) => {
      const until = liveUntil.get(keyXdr(key));
      return until === undefined || until < latestLedger;
    });
    if (pending.length === 0) {
      return {
        type: 'ALREADY_DONE',
        note: 'Las entradas ya están vivas en la red',
      };
    }
    return { type: 'FOOTPRINT', action: 'RESTORE', keys: pending };
  }
}
