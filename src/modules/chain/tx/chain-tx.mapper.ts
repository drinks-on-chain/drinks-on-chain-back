import type { ChainTransaction, ChainTxAttempt } from '@prisma/client';
import type {
  ChainNetwork,
  ChainSignerRole,
  ChainSubjectType,
  ChainTxKind,
  ChainTxStatus,
} from '../chain.constants';
import { STROOPS_PER_XLM } from '../chain.constants';
import type { ChainTxRefDto } from '../dto/chain-common.dto';
import type { ChainTransactionDto } from '../dto/chain.dto';
import { explorerTxUrl } from '../explorer';

interface StoredError {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
}

function lastErrorOf(row: ChainTransaction): ChainTxRefDto['lastError'] {
  const stored = row.lastError as StoredError | null;
  if (!stored || typeof stored.code !== 'string') return null;
  return {
    code: stored.code,
    message: typeof stored.message === 'string' ? stored.message : stored.code,
    retryable: stored.retryable === true,
  };
}

/** Lo que ven el ERP, el Backoffice y el Marketplace (§2.3 `ChainTxRef`). */
export function toChainTxRef(
  row: ChainTransaction,
  explorerBaseUrl: string | null,
): ChainTxRefDto {
  return {
    id: row.id,
    kind: row.kind as ChainTxKind,
    status: row.status as ChainTxStatus,
    network: row.network as ChainNetwork,
    txHash: row.txHash,
    explorerUrl: explorerTxUrl(explorerBaseUrl, row.txHash),
    ledger: row.ledger,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    attempts: row.attempts,
    lastError: lastErrorOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type StoredSigner = { role?: unknown; address?: unknown; wineryId?: unknown };

function signersOf(row: ChainTransaction): ChainTransactionDto['signers'] {
  if (!Array.isArray(row.signers)) return [];
  return (row.signers as StoredSigner[])
    .filter(
      (signer) =>
        typeof signer?.role === 'string' && typeof signer.address === 'string',
    )
    .map((signer) => ({
      role: signer.role as ChainSignerRole,
      address: signer.address as string,
      wineryId: typeof signer.wineryId === 'string' ? signer.wineryId : null,
    }));
}

type StoredResult = { returnValue?: unknown; contractEvents?: unknown };

function resultOf(row: ChainTransaction): ChainTransactionDto['result'] {
  const stored = row.result as StoredResult | null;
  if (!stored || typeof stored !== 'object') return null;
  return {
    returnValue: stored.returnValue ?? null,
    contractEvents: Array.isArray(stored.contractEvents)
      ? stored.contractEvents.filter(
          (event): event is string => typeof event === 'string',
        )
      : [],
  };
}

/** Transacción completa con su historial: solo para la plataforma (§2.3). */
export function toChainTransaction(
  row: ChainTransaction & { attemptsLog?: ChainTxAttempt[] },
  explorerBaseUrl: string | null,
): ChainTransactionDto {
  const history = [...(row.attemptsLog ?? [])]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((entry) => ({
      attempt: entry.attempt,
      status: entry.status as ChainTxStatus,
      at: entry.at.toISOString(),
      txHash: entry.txHash,
      sequence: entry.sequence,
      errorCode: entry.errorCode,
      detail: entry.detail,
    }));
  return {
    ...toChainTxRef(row, explorerBaseUrl),
    intentKey: row.intentKey,
    subject: {
      type: row.subjectType as ChainSubjectType,
      id: row.subjectId,
    },
    wineryId: row.wineryId,
    intent: (row.intent ?? {}) as Record<string, unknown>,
    sourceAccount: row.sourceAccount,
    signers: signersOf(row),
    feeChargedStroops: row.feeChargedStroops?.toString() ?? null,
    rentFeeStroops: row.rentFeeStroops?.toString() ?? null,
    maxFeeStroops: row.maxFeeStroops?.toString() ?? null,
    result: resultOf(row),
    history,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    requestedBy: {
      userId: row.requestedByUserId,
      fullName: row.requestedByName,
      source: row.requestedSource === 'API' ? 'API' : 'WORKER',
    },
    abandoned:
      row.abandonedAt !== null
        ? {
            at: row.abandonedAt.toISOString(),
            by: row.abandonedBy ?? '',
            reason: row.abandonReason ?? '',
          }
        : null,
    correlationId: row.correlationId,
  };
}

/** Stroops → XLM con 7 decimales (`"0.1389000"`, §0). */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** XLM (`"2"`, `"0.5"`) → stroops. */
export function xlmToStroops(xlm: string): bigint {
  const [whole, fraction = ''] = xlm.trim().split('.');
  return (
    BigInt(whole || '0') * STROOPS_PER_XLM +
    BigInt(fraction.padEnd(7, '0').slice(0, 7) || '0')
  );
}
