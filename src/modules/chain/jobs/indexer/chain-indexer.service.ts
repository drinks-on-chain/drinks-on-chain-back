import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ChainAlertsWriter } from '../../alerts/chain-alerts.writer';
import { CHAIN_SETTINGS, type ChainSettings } from '../../chain.config';
import { INDEXER_GAP_DAYS } from '../../chain.constants';
import { ChainTxFailure } from '../../tx/chain-tx.errors';
import {
  ReconciliationAlreadyRunning,
  ReconciliationRunsService,
} from '../../reconciliation/reconciliation-runs.service';
import {
  CHAIN_GATEWAY,
  EVENTS_CONTRACTS_PER_CALL,
  type ChainGateway,
  type EventsPage,
  type IndexedChainEvent,
} from '../gateway/chain-gateway';

/** Nombre del cursor de eventos en `chain_cursors` (uno por red). */
export const EVENTS_CURSOR = 'events';
const DAY_MS = 86_400_000;
/** Páginas por grupo de contratos y pasada: lo que falte, en la siguiente. */
const MAX_PAGES_PER_GROUP = 50;
const PAGE_LIMIT = 200;

export interface IndexerResult {
  status: 'DISABLED' | 'IDLE' | 'INDEXED' | 'NETWORK_RESET' | 'UNAVAILABLE';
  fromLedger: number | null;
  toLedger: number | null;
  events: number;
  unexpected: number;
  gap: boolean;
}

interface ContractRef {
  id: string;
  address: string;
  wineryId: string;
  chainAccountId: string;
}

/**
 * Ledger de un cursor de `getEvents` (`{toid}-{índice}`: el TOID lleva el
 * ledger en sus 32 bits altos); `null` si no se puede leer.
 */
export function ledgerOfCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  try {
    return Number(BigInt(cursor.split('-')[0]) >> 32n);
  } catch {
    return null;
  }
}

const asInteger = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
};

/**
 * Indexador de eventos de los contratos (contrato O3 §8.1, CHN-11). Cada
 * pasada lee con `getEvents` lo ocurrido desde el cursor guardado hasta el
 * último ledger del RPC, por grupos de contratos, y por cada evento:
 *
 * - lo guarda en `chain_events` (único por `rpcEventId`: releerlo es inocuo);
 * - lo enlaza con la transacción propia que lo originó (por su hash, también
 *   el de un intento anterior de la misma intención);
 * - refleja lo que dice la red en `Token.onchain*` y, si el evento es de una
 *   transacción propia, en la pausa de la identidad;
 * - si **no** lo originó el sistema, abre una alerta `CRITICAL`
 *   `UNEXPECTED_EVENT`.
 *
 * Nunca corrige el estado de negocio (dueño, estado del NFT, colecciones):
 * eso lo compara la conciliación y lo decide una persona (S-19).
 */
@Injectable()
export class ChainIndexer {
  private readonly logger = new Logger(ChainIndexer.name);
  /** Una pasada a la vez en este proceso (la tarea se repite cada 60 s). */
  private running: Promise<IndexerResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: ChainAlertsWriter,
    private readonly runs: ReconciliationRunsService,
    @Inject(CHAIN_GATEWAY) private readonly gateway: ChainGateway,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  poll(now: Date = new Date()): Promise<IndexerResult> {
    if (!this.running) {
      this.running = this.pollOnce(now)
        .catch((error: unknown): IndexerResult => {
          // La red no responde: el cursor no se mueve y la siguiente pasada
          // (cada 60 s) lo vuelve a intentar
          if (!(error instanceof ChainTxFailure)) throw error;
          this.logger.warn(
            `Indexador aplazado: ${error.code} ${error.detail ?? ''}`.trim(),
          );
          return {
            status: 'UNAVAILABLE',
            fromLedger: null,
            toLedger: null,
            events: 0,
            unexpected: 0,
            gap: false,
          };
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private async pollOnce(now: Date): Promise<IndexerResult> {
    const result: IndexerResult = {
      status: 'DISABLED',
      fromLedger: null,
      toLedger: null,
      events: 0,
      unexpected: 0,
      gap: false,
    };
    if (!this.settings.enabled) return result;
    const { network } = this.settings;
    const window = await this.gateway.ledgerWindow();
    const cursor = await this.prisma.chainCursor.findUnique({
      where: { network_name: { network, name: EVENTS_CURSOR } },
    });

    // La secuencia de ledgers retrocedió: la red se reinició (S-22)
    if (cursor?.lastLedger != null && window.latest < cursor.lastLedger) {
      await this.prisma.$transaction((db) =>
        this.alerts.raise(db, {
          code: 'NETWORK_RESET',
          level: 'CRITICAL',
          subjectType: 'NETWORK',
          subjectId: network,
          message: `La red ${network} retrocedió del ledger ${cursor.lastLedger} al ${window.latest}: parece un reinicio. Sigue el procedimiento del README del despliegue`,
          expected: { lastIndexedLedger: cursor.lastLedger },
          actual: { latestLedger: window.latest },
        }),
      );
      return { ...result, status: 'NETWORK_RESET' };
    }

    const start = await this.startLedger(cursor?.lastLedger ?? null);
    // Hueco: el RPC ya no guarda desde donde tocaba, o el cursor lleva días parado
    const stale =
      cursor !== null &&
      now.getTime() - cursor.updatedAt.getTime() > INDEXER_GAP_DAYS * DAY_MS;
    if (start !== null && (start < window.oldest || stale)) {
      result.gap = true;
      await this.reportGap(start, window, stale);
    }
    const from = start === null ? null : Math.max(start, window.oldest);
    result.fromLedger = from;
    result.toLedger = window.latest;

    let lastEventId: string | null = null;
    let through = window.latest;
    if (from !== null && from <= window.latest) {
      const contracts = await this.contracts();
      const page = await this.read(contracts, from, window.latest);
      through = page.through;
      const byAddress = new Map(contracts.map((c) => [c.address, c]));
      for (const event of page.events) {
        const outcome = await this.store(event, byAddress);
        if (outcome === 'DUPLICATE') continue;
        result.events += 1;
        if (outcome === 'UNEXPECTED') result.unexpected += 1;
        lastEventId = event.rpcEventId;
      }
      result.status = 'INDEXED';
      result.toLedger = through;
    } else {
      result.status = 'IDLE';
    }

    const data = {
      // Hasta donde se leyó de verdad: lo demás, en la siguiente pasada
      lastLedger: Math.max(through, cursor?.lastLedger ?? 0),
      ...(lastEventId ? { cursor: lastEventId } : {}),
      // `updatedAt` es el latido del indexador (`indexerLagSeconds` del tablero)
      updatedAt: now,
    };
    await this.prisma.chainCursor.upsert({
      where: { network_name: { network, name: EVENTS_CURSOR } },
      create: { network, name: EVENTS_CURSOR, ...data },
      update: data,
    });
    if (result.events > 0 || result.gap) {
      this.logger.log({ message: 'Eventos de la cadena indexados', ...result });
    }
    return result;
  }

  /**
   * Primer ledger de la pasada: el siguiente al último indexado o, la primera
   * vez, el de la transacción propia más antigua de esta red. `null` = aún no
   * hay nada que indexar.
   */
  private async startLedger(lastLedger: number | null): Promise<number | null> {
    if (lastLedger !== null) return lastLedger + 1;
    const first = await this.prisma.chainTransaction.aggregate({
      where: { network: this.settings.network, ledger: { not: null } },
      _min: { ledger: true },
    });
    return first._min.ledger ?? null;
  }

  private async contracts(): Promise<ContractRef[]> {
    const rows = await this.prisma.nftContract.findMany({
      where: { network: this.settings.network, address: { not: null } },
      select: { id: true, address: true, wineryId: true, chainAccountId: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.filter((row): row is ContractRef => row.address !== null);
  }

  /**
   * Eventos de todos los contratos entre `from` y `to`, en orden, y hasta qué
   * ledger se leyó de verdad (`through`). `getEvents` recorre un tramo
   * limitado de ledgers por llamada y devuelve un cursor para seguir: se
   * pagina hasta alcanzar `to`. Si el RPC aún no sirve los eventos del último
   * ledger, o una pasada agota sus páginas, `through` queda antes y el resto
   * se lee en la siguiente.
   */
  private async read(
    contracts: ContractRef[],
    from: number,
    to: number,
  ): Promise<{ events: IndexedChainEvent[]; through: number }> {
    const events: IndexedChainEvent[] = [];
    let through = to;
    for (let i = 0; i < contracts.length; i += EVENTS_CONTRACTS_PER_CALL) {
      const contractIds = contracts
        .slice(i, i + EVENTS_CONTRACTS_PER_CALL)
        .map((c) => c.address);
      let cursor: string | null = null;
      let complete = false;
      for (let page = 0; page < MAX_PAGES_PER_GROUP && !complete; page += 1) {
        let response: EventsPage;
        try {
          response = await this.gateway.eventsPage({
            contractIds,
            startLedger: from,
            cursor,
            limit: PAGE_LIMIT,
          });
        } catch (error) {
          // El RPC aún no sirve eventos desde `from` (va un ledger por
          // detrás de `getHealth`): no hay nada nuevo que leer todavía
          if (cursor === null && error instanceof ChainTxFailure) {
            return { events: [], through: from - 1 };
          }
          throw error;
        }
        through = Math.min(through, response.latestLedger);
        events.push(...response.events);
        const scanned = ledgerOfCursor(response.cursor);
        const full = response.events.length >= PAGE_LIMIT;
        complete =
          response.events.some((e) => e.ledger > through) ||
          response.cursor === null ||
          response.cursor === cursor ||
          (!full && (scanned === null || scanned >= through));
        cursor = response.cursor;
      }
      if (!complete) {
        // Páginas agotadas: solo es seguro lo anterior al ledger del cursor
        const scanned = ledgerOfCursor(cursor);
        if (scanned !== null) through = Math.min(through, scanned - 1);
      }
    }
    return {
      events: events
        .filter((event) => event.ledger <= through)
        .sort((a, b) =>
          a.rpcEventId < b.rpcEventId
            ? -1
            : a.rpcEventId > b.rpcEventId
              ? 1
              : 0,
        ),
      through,
    };
  }

  private async reportGap(
    start: number,
    window: { latest: number; oldest: number },
    stale: boolean,
  ): Promise<void> {
    const { network } = this.settings;
    await this.prisma.$transaction(async (db) => {
      const raised = await this.alerts.raise(db, {
        code: 'INDEXER_GAP',
        level: 'CRITICAL',
        subjectType: 'NETWORK',
        subjectId: network,
        message:
          start < window.oldest
            ? `El indexador debía leer desde el ledger ${start} y el RPC solo guarda desde el ${window.oldest}: puede haber eventos sin indexar. Se lanza una conciliación completa`
            : `El indexador llevaba más de ${INDEXER_GAP_DAYS} días sin avanzar (la retención del RPC es de unos 7). Se lanza una conciliación completa`,
        expected: { fromLedger: start },
        actual: {
          oldestLedger: window.oldest,
          latestLedger: window.latest,
          stale,
        },
      });
      if (!raised) return;
      try {
        await this.runs.open(db, {
          scope: 'ALL',
          depth: 'FULL',
          trigger: 'INDEXER_GAP',
        });
      } catch (error) {
        // Ya hay una completa en curso: esa cubre el hueco
        if (!(error instanceof ReconciliationAlreadyRunning)) throw error;
      }
    });
  }

  /** Guarda un evento con sus efectos; `DUPLICATE` si ya estaba. */
  private async store(
    event: IndexedChainEvent,
    contracts: Map<string, ContractRef>,
  ): Promise<'STORED' | 'UNEXPECTED' | 'DUPLICATE'> {
    const { network } = this.settings;
    const contract = contracts.get(event.contractAddress) ?? null;
    return this.prisma.$transaction(async (db) => {
      const existing = await db.chainEvent.findUnique({
        where: { rpcEventId: event.rpcEventId },
        select: { id: true },
      });
      if (existing) return 'DUPLICATE';
      const matched = await this.ownTransaction(db, event.txHash);
      await db.chainEvent.create({
        data: {
          rpcEventId: event.rpcEventId,
          network,
          contractAddress: event.contractAddress,
          wineryId: contract?.wineryId ?? null,
          ledger: event.ledger,
          ledgerClosedAt: event.closedAt,
          txHash: event.txHash,
          type: event.name.slice(0, 40),
          topics: event.topics as Prisma.InputJsonArray,
          data: event.data as Prisma.InputJsonObject,
          matchedTransactionId: matched?.id ?? null,
          originatedBySystem: matched !== null,
        },
      });
      if (contract) await this.apply(db, event, contract, matched);
      if (matched) return 'STORED';
      await this.alerts.raise(db, {
        code: 'UNEXPECTED_EVENT',
        level: 'CRITICAL',
        subjectType: 'EVENT',
        subjectId: event.rpcEventId,
        wineryId: contract?.wineryId ?? null,
        message: `Evento ${event.name} de un contrato de la plataforma que no originó ninguna transacción del sistema (${event.txHash.slice(0, 12)}…)`,
        expected: { originatedBySystem: true },
        actual: {
          type: event.name,
          contract: event.contractAddress,
          txHash: event.txHash,
          ledger: event.ledger,
          topics: event.topics as Prisma.InputJsonArray,
          data: event.data as Prisma.InputJsonObject,
        },
      });
      return 'UNEXPECTED';
    });
  }

  /** Transacción propia con ese hash (el vigente o el de un intento anterior). */
  private async ownTransaction(
    db: Prisma.TransactionClient,
    txHash: string,
  ): Promise<{ id: string; kind: string; status: string } | null> {
    const { network } = this.settings;
    const select = { id: true, kind: true, status: true } as const;
    const direct = await db.chainTransaction.findFirst({
      where: { network, txHash },
      select,
    });
    if (direct) return direct;
    const attempt = await db.chainTxAttempt.findFirst({
      where: { txHash, transaction: { network } },
      select: { transaction: { select } },
    });
    return attempt?.transaction ?? null;
  }

  /**
   * Lo que el evento dice de la red (§8.1): `lot_minted` confirma el rango
   * de su emisión, `transfer` y `burn` actualizan `Token.onchain*` y
   * `paused`/`unpaused` de una transacción propia, la identidad.
   */
  private async apply(
    db: Prisma.TransactionClient,
    event: IndexedChainEvent,
    contract: ContractRef,
    matched: { id: string; kind: string; status: string } | null,
  ): Promise<void> {
    const checkedAt = event.closedAt;
    const tokenId = asInteger(event.data.token_id);
    switch (event.name) {
      case 'lot_minted': {
        const first = asInteger(event.data.first_token_id);
        const last = asInteger(event.data.last_token_id);
        const to = event.topics[1];
        if (first === null || last === null || typeof to !== 'string') return;
        await db.token.updateMany({
          where: {
            contractId: contract.id,
            tokenId: { gte: first, lte: last },
            onchainBurned: false,
          },
          data: { onchainOwner: to, onchainCheckedAt: checkedAt },
        });
        if (matched?.kind === 'MINT_BATCH' && matched.status === 'CONFIRMED') {
          await this.confirmRange(db, matched.id, contract, first, last);
        }
        return;
      }
      case 'transfer': {
        const to = event.topics[1];
        if (tokenId === null || typeof to !== 'string') return;
        await db.token.updateMany({
          where: { contractId: contract.id, tokenId },
          data: { onchainOwner: to, onchainCheckedAt: checkedAt },
        });
        return;
      }
      case 'burn': {
        if (tokenId === null) return;
        await db.token.updateMany({
          where: { contractId: contract.id, tokenId },
          data: {
            onchainOwner: null,
            onchainBurned: true,
            onchainCheckedAt: checkedAt,
          },
        });
        return;
      }
      case 'paused':
      case 'unpaused': {
        // Solo la pausa pedida por el sistema mueve la identidad; la de
        // cualquier otro origen queda como alerta y `PAUSE_MISMATCH`
        if (!matched) return;
        const paused = event.name === 'paused';
        await db.nftContract.updateMany({
          where: { id: contract.id, status: 'ACTIVE' },
          data: { paused },
        });
        await db.chainAccount.updateMany({
          where: {
            id: contract.chainAccountId,
            status: paused ? 'ACTIVE' : 'PAUSED',
          },
          data: { status: paused ? 'PAUSED' : 'ACTIVE' },
        });
        return;
      }
      default:
    }
  }

  /** El rango del evento debe ser uno de los que registró su emisión. */
  private async confirmRange(
    db: Prisma.TransactionClient,
    transactionId: string,
    contract: ContractRef,
    first: number,
    last: number,
  ): Promise<void> {
    const tx = await db.chainTransaction.findUnique({
      where: { id: transactionId },
      select: { subjectId: true },
    });
    const mint = tx
      ? await db.mint.findUnique({
          where: { id: tx.subjectId },
          select: { id: true, ranges: true, status: true },
        })
      : null;
    if (!mint || mint.status === 'FAILED') return; // ya tiene su alerta
    const ranges = Array.isArray(mint.ranges)
      ? (mint.ranges as { firstTokenId?: unknown; lastTokenId?: unknown }[])
      : [];
    if (
      ranges.some((r) => r.firstTokenId === first && r.lastTokenId === last)
    ) {
      return;
    }
    await this.alerts.raise(db, {
      code: 'MINT_RANGE_MISMATCH',
      level: 'CRITICAL',
      subjectType: 'MINT',
      subjectId: mint.id,
      wineryId: contract.wineryId,
      message: `El evento lot_minted de la red (${first}–${last}) no es ninguno de los rangos registrados de la emisión`,
      expected: { ranges: mint.ranges as Prisma.InputJsonValue },
      actual: { firstTokenId: first, lastTokenId: last },
    });
  }
}
