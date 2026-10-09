/**
 * Errores de una transacción de la cadena (contrato O3 §2.3 y §9): códigos
 * internos de `ChainTransaction.lastError`, con su tipo (transitorio o
 * definitivo). Sin dependencias del SDK: lo comparten la API y el worker.
 */

export type ChainTxErrorCode =
  | 'CHN_RPC_UNAVAILABLE'
  | 'CHN_TX_TIMEOUT'
  | 'CHN_BAD_SEQUENCE'
  | 'CHN_INSUFFICIENT_FEE'
  | 'CHN_TRY_AGAIN_LATER'
  | 'CHN_ARCHIVED_ENTRY'
  | 'CHN_CONTRACT_ERROR'
  | 'CHN_AUTH_FAILED'
  | 'CHN_INSUFFICIENT_BALANCE'
  | 'CHN_INTENT_REJECTED'
  | 'CHN_MINT_DISABLED'
  | 'CHN_WINERY_NOT_ACTIVE'
  | 'CHN_NETWORK_RESET';

/** Transitorios: el worker reintenta solo con las esperas de S-4. */
export const TRANSIENT_CHAIN_TX_ERRORS: readonly ChainTxErrorCode[] = [
  'CHN_RPC_UNAVAILABLE',
  'CHN_TX_TIMEOUT',
  'CHN_BAD_SEQUENCE',
  'CHN_INSUFFICIENT_FEE',
  'CHN_TRY_AGAIN_LATER',
  'CHN_ARCHIVED_ENTRY',
];

/** Definitivos que además abren una alerta `CRITICAL` (§2.3). */
export const CRITICAL_CHAIN_TX_ERRORS: readonly ChainTxErrorCode[] = [
  'CHN_AUTH_FAILED',
  'CHN_INTENT_REJECTED',
];

export const isTransientChainTxError = (code: string): boolean =>
  (TRANSIENT_CHAIN_TX_ERRORS as readonly string[]).includes(code);

const MESSAGES: Record<ChainTxErrorCode, string> = {
  CHN_RPC_UNAVAILABLE: 'La red no responde; se reintentará',
  CHN_TX_TIMEOUT: 'La transacción no entró en la red a tiempo; se reintentará',
  CHN_BAD_SEQUENCE:
    'El número de secuencia ya se usó; se reconstruye la transacción',
  CHN_INSUFFICIENT_FEE: 'La comisión no alcanzó; se recalcula y se reintenta',
  CHN_TRY_AGAIN_LATER: 'La red pidió esperar; se reintentará',
  CHN_ARCHIVED_ENTRY:
    'Hay datos archivados en la red que restaurar antes de reintentar',
  CHN_CONTRACT_ERROR: 'El contrato o la red rechazaron la operación',
  CHN_AUTH_FAILED: 'La firma de la autorización no es válida',
  CHN_INSUFFICIENT_BALANCE:
    'La cuenta que paga no tiene saldo suficiente; recárgala y reintenta',
  CHN_INTENT_REJECTED:
    'La intención no cuadra con los datos del sistema; no se firmó',
  CHN_MINT_DISABLED: 'La emisión está deshabilitada en este entorno',
  CHN_WINERY_NOT_ACTIVE:
    'La bodega no está activa: la emisión espera a que se reactive',
  CHN_NETWORK_RESET: 'La red se reinició; hay que regenerar la identidad',
};

/**
 * Fallo de una transacción con su código de §2.3. `detail` es el código de
 * resultado de la red o del contrato (historial); nunca lleva claves,
 * semillas ni XDR firmado.
 */
export class ChainTxFailure extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: ChainTxErrorCode,
    readonly detail: string | null = null,
    message?: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message ?? MESSAGES[code]);
    this.name = 'ChainTxFailure';
    this.retryable = isTransientChainTxError(code);
  }
}

/**
 * La simulación pide restaurar entradas archivadas (§2.3, §8.3): el firmante
 * encadena `RESTORE_ENTRIES` con estas claves (`LedgerKey` en XDR base64) y
 * reintenta. Las claves no van al historial ni a `lastError`.
 */
export class ArchivedEntriesFailure extends ChainTxFailure {
  constructor(readonly ledgerKeys: readonly string[]) {
    super(
      'CHN_ARCHIVED_ENTRY',
      `la simulación pide restaurar ${ledgerKeys.length} entrada(s)`,
    );
    this.name = 'ArchivedEntriesFailure';
  }
}

/** La intención no supera la validación de §2.2: nunca se firma. */
export class IntentRejected extends ChainTxFailure {
  constructor(reason: string) {
    super('CHN_INTENT_REJECTED', reason, `Intención rechazada: ${reason}`);
    this.name = 'IntentRejected';
  }
}

/** La intención espera a una condición (p. ej. `CHAIN_MINT_ENABLED`). */
export class IntentOnHold extends Error {
  constructor(
    readonly code: ChainTxErrorCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = 'IntentOnHold';
  }
}

/**
 * La intención es válida pero aún no le toca (p. ej. el trozo anterior de una
 * emisión sigue sin confirmarse): se deja como está, sin gastar un intento, y
 * el barrido la vuelve a despertar.
 */
export class IntentNotReady extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'IntentNotReady';
  }
}

/** Códigos de resultado de transacción (`TransactionResultCode`) → §2.3. */
const TX_RESULT_CODES: Record<string, ChainTxErrorCode> = {
  txBadSeq: 'CHN_BAD_SEQUENCE',
  txInsufficientFee: 'CHN_INSUFFICIENT_FEE',
  txSorobanInvalid: 'CHN_INSUFFICIENT_FEE',
  txTooLate: 'CHN_TX_TIMEOUT',
  txTooEarly: 'CHN_TX_TIMEOUT',
  txBadAuth: 'CHN_AUTH_FAILED',
  txBadAuthExtra: 'CHN_AUTH_FAILED',
  txInsufficientBalance: 'CHN_INSUFFICIENT_BALANCE',
  txNoAccount: 'CHN_INSUFFICIENT_BALANCE',
  txInternalError: 'CHN_RPC_UNAVAILABLE',
};

/** Código de §2.3 de un resultado de transacción rechazado al enviarla. */
export function failureFromTxResultCode(resultCode: string): ChainTxFailure {
  return new ChainTxFailure(
    TX_RESULT_CODES[resultCode] ?? 'CHN_CONTRACT_ERROR',
    resultCode,
  );
}

// Dos formas: el texto de la simulación (`Error(Contract, #1000)`) y el JSON
// del XDR de un resultado o un evento de diagnóstico (`{"contract":1000}`)
const CONTRACT_ERROR = /Error\(Contract, #(\d+)\)|"contract":\s*(\d+)/;
const AUTH_ERROR = /Error\(Auth, [A-Za-z]+\)|"auth":\s*"[a-z_]+"/;
const BUDGET_ERROR = /Error\(Budget, [A-Za-z]+\)|"budget":\s*"[a-z_]+"/;
const ARCHIVED = /archived|EntryArchived|entry_archived/i;
const UNDERFUNDED = /underfunded|low_reserve|insufficient_balance/i;

/**
 * Clasifica el texto de un fallo de la red o de la simulación (error de la
 * simulación, eventos de diagnóstico o el resultado en JSON de una
 * transacción `FAILED`). El orden importa: una autorización inválida también
 * aparece como error del contrato que la exigía.
 */
export function failureFromDiagnostics(text: string): ChainTxFailure {
  const detail = summarizeDiagnostics(text);
  if (AUTH_ERROR.test(text)) {
    return new ChainTxFailure('CHN_AUTH_FAILED', detail);
  }
  const contract = CONTRACT_ERROR.exec(text);
  if (contract) {
    const contractErrorCode = Number(contract[1] ?? contract[2]);
    return new ChainTxFailure(
      'CHN_CONTRACT_ERROR',
      detail,
      `El contrato rechazó la operación (error ${contractErrorCode})`,
      { contractErrorCode },
    );
  }
  if (ARCHIVED.test(text)) {
    return new ChainTxFailure('CHN_ARCHIVED_ENTRY', detail);
  }
  if (BUDGET_ERROR.test(text) || /resource_limit_exceeded/i.test(text)) {
    return new ChainTxFailure('CHN_INSUFFICIENT_FEE', detail);
  }
  if (UNDERFUNDED.test(text)) {
    return new ChainTxFailure('CHN_INSUFFICIENT_BALANCE', detail);
  }
  return new ChainTxFailure('CHN_CONTRACT_ERROR', detail);
}

const MAX_DETAIL = 300;

/** Primera línea útil de un diagnóstico, acotada (va al historial). */
export function summarizeDiagnostics(text: string): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  return firstLine.slice(0, MAX_DETAIL);
}
