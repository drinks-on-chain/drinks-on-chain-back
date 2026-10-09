import type { ChainTransaction, DossierAnchor } from '@prisma/client';
import type {
  ChainNetwork,
  DossierAnchorStatus,
  VerificationCheckKey,
} from '../chain.constants';
import type {
  DossierAnchorDto,
  PublicDossierAnchorDto,
} from '../dto/chain-common.dto';
import { explorerTxUrl, memoHashFromHex } from '../explorer';
import { toChainTxRef } from '../tx/chain-tx.mapper';

export type AnchorRow = DossierAnchor & {
  transaction: ChainTransaction | null;
};

/**
 * Estado del anclaje para quien lo lee (§7.1): la fila guarda `PENDING`,
 * `ANCHORED` o `FAILED`; `SUBMITTED` es su transacción ya enviada a la red.
 */
export function anchorStatus(row: AnchorRow): DossierAnchorStatus {
  if (row.status === 'PENDING' && row.transaction?.status === 'SUBMITTED') {
    return 'SUBMITTED';
  }
  return row.status as DossierAnchorStatus;
}

/** `DossierAnchor` (§7.1) para el ERP y el back office; `null` sin transacción. */
export function toDossierAnchor(
  row: AnchorRow | null | undefined,
  explorerBaseUrl: string | null,
): DossierAnchorDto | null {
  if (!row?.transaction) return null;
  const memo = memoHashFromHex(row.memoHashHex);
  return {
    status: anchorStatus(row),
    network: row.network as ChainNetwork,
    account: row.account,
    memoHashHex: memo.hex,
    memoHashBase64: memo.base64,
    txHash: row.txHash,
    ledger: row.ledger,
    anchoredAt: row.anchoredAt?.toISOString() ?? null,
    explorerUrl: explorerTxUrl(explorerBaseUrl, row.txHash),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    transaction: toChainTxRef(row.transaction, explorerBaseUrl),
  };
}

/**
 * `PublicDossierAnchor` (§7.3): en público solo hay "pendiente" o "anclado".
 * Un anclaje `FAILED` o a medias se publica como `PENDING` y sin transacción
 * (S-17): nada se enseña como anclado si no lo está y se verificó.
 */
export function toPublicDossierAnchor(
  row:
    | Pick<
        DossierAnchor,
        | 'status'
        | 'network'
        | 'account'
        | 'memoHashHex'
        | 'txHash'
        | 'ledger'
        | 'anchoredAt'
        | 'verifiedAt'
      >
    | null
    | undefined,
  explorerBaseUrl: string | null,
): PublicDossierAnchorDto | null {
  if (!row) return null;
  const memo = memoHashFromHex(row.memoHashHex);
  const anchored = row.status === 'ANCHORED' && row.verifiedAt !== null;
  return {
    status: anchored ? 'ANCHORED' : 'PENDING',
    network: row.network as ChainNetwork,
    account: row.account,
    memoHashHex: memo.hex,
    memoHashBase64: memo.base64,
    txHash: anchored ? row.txHash : null,
    ledger: anchored ? row.ledger : null,
    anchoredAt: anchored ? (row.anchoredAt?.toISOString() ?? null) : null,
    explorerUrl: anchored ? explorerTxUrl(explorerBaseUrl, row.txHash) : null,
  };
}

export interface VerificationCheck {
  key: VerificationCheckKey;
  /** `null` = aún no aplica. */
  pass: boolean | null;
  message: string;
}

/**
 * Las cuatro comprobaciones de la verificación pública (§7.3), en orden.
 * Cada una depende de la anterior: sin expediente cerrado no hay anclaje que
 * mirar; sin anclaje confirmado, el memo y la cuenta "aún no aplican".
 */
export function verificationChecks(input: {
  dossierHash: string | null;
  anchor: Pick<
    DossierAnchor,
    'status' | 'account' | 'memoHashHex' | 'verifiedAt'
  > | null;
  officialAnchorAccount: string | null;
}): VerificationCheck[] {
  const { dossierHash, anchor, officialAnchorAccount } = input;
  const closed = dossierHash !== null;
  const confirmed =
    closed && anchor?.status === 'ANCHORED' && anchor.verifiedAt !== null;
  const memoMatches = confirmed
    ? anchor.memoHashHex.toLowerCase() === dossierHash.toLowerCase()
    : null;
  const official = confirmed
    ? officialAnchorAccount !== null && anchor.account === officialAnchorAccount
    : null;
  return [
    {
      key: 'DOSSIER_CLOSED',
      pass: closed,
      message: closed
        ? 'El expediente del lote está cerrado y tiene huella'
        : 'El expediente del lote aún no está cerrado',
    },
    {
      key: 'ANCHOR_CONFIRMED',
      pass: closed ? confirmed : null,
      message: !closed
        ? 'Se comprobará cuando el expediente esté cerrado'
        : confirmed
          ? 'La transacción de anclaje está confirmada en la red'
          : 'Anclaje en la red: pendiente',
    },
    {
      key: 'MEMO_MATCHES_HASH',
      pass: memoMatches,
      message:
        memoMatches === null
          ? 'Se comprobará cuando el anclaje esté confirmado'
          : memoMatches
            ? 'El memo de la transacción es la huella del expediente'
            : 'El memo de la transacción no coincide con la huella del expediente',
    },
    {
      key: 'ANCHOR_ACCOUNT_OFFICIAL',
      pass: official,
      message:
        official === null
          ? 'Se comprobará cuando el anclaje esté confirmado'
          : official
            ? 'La transacción la firmó la cuenta de anclaje oficial'
            : 'La transacción no es de la cuenta de anclaje oficial',
    },
  ];
}
