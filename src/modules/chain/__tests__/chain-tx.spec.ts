import type { ChainTransaction, ChainTxAttempt } from '@prisma/client';
import { balanceStatus } from '../accounts/platform-accounts.service';
import { CHAIN_DEFAULTS } from '../chain.config';
import {
  CHAIN_TX_STATUSES,
  intentKeys,
  type ChainTxStatus,
} from '../chain.constants';
import {
  contractBaseUri,
  contractName,
  contractSalt,
  contractSymbol,
  predictContractAddress,
  truncateUtf8,
} from '../identity/identity-params';
import {
  buildStellarToml,
  tomlString,
} from '../identity/public-chain-registry.service';
import {
  ChainTxFailure,
  IntentRejected,
  failureFromDiagnostics,
  failureFromTxResultCode,
  isTransientChainTxError,
} from '../tx/chain-tx.errors';
import {
  stroopsToXlm,
  toChainTransaction,
  toChainTxRef,
  xlmToStroops,
} from '../tx/chain-tx.mapper';
import {
  InvalidChainTxTransition,
  assertTransition,
  canRebuildAfterNotFound,
  canTransition,
  decideRetry,
  maxAttempts,
} from '../tx/chain-tx.state';

const HASH = 'a'.repeat(64);
const ACCOUNT = 'GC3YJAM34SF6MV3CL4NY37SAB3UMHQQ2NT24FPDNWRV3FFWLJSDNOP63';

function row(overrides: Partial<ChainTransaction> = {}): ChainTransaction {
  const at = new Date('2026-10-09T12:00:00.000Z');
  return {
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    kind: 'PAUSE_CONTRACT',
    status: 'PENDING',
    network: 'TESTNET',
    intentKey: 'pause:c:a',
    subjectType: 'CONTRACT',
    subjectId: 'c',
    wineryId: null,
    intent: {},
    sourceAccount: null,
    signers: [],
    txHash: null,
    ledger: null,
    confirmedAt: null,
    attempts: 0,
    lastError: null,
    feeChargedStroops: null,
    rentFeeStroops: null,
    maxFeeStroops: null,
    result: null,
    nextAttemptAt: null,
    maxTime: null,
    requestedByUserId: null,
    requestedByName: null,
    requestedSource: 'WORKER',
    abandonedAt: null,
    abandonedBy: null,
    abandonReason: null,
    correlationId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('Ciclo de estados de una transacción (contrato O3 §2.3)', () => {
  const allowed: [ChainTxStatus, ChainTxStatus][] = [
    ['PENDING', 'BUILDING'],
    ['BUILDING', 'SUBMITTED'],
    ['SUBMITTED', 'CONFIRMED'],
    ['SUBMITTED', 'RETRYING'],
    ['BUILDING', 'RETRYING'],
    ['RETRYING', 'BUILDING'],
    ['SUBMITTED', 'FAILED'],
    ['RETRYING', 'FAILED'],
    ['FAILED', 'PENDING'],
    // La intención no supera la validación: nunca llega a construirse
    ['PENDING', 'FAILED'],
    // La red ya tenía el efecto (idempotencia) o la intención no firma
    ['BUILDING', 'CONFIRMED'],
    ['RETRYING', 'CONFIRMED'],
  ];

  it('admite exactamente las transiciones del ciclo', () => {
    for (const from of CHAIN_TX_STATUSES) {
      for (const to of CHAIN_TX_STATUSES) {
        const expected =
          allowed.some(([a, b]) => a === from && b === to) ||
          (from === 'BUILDING' && to === 'FAILED');
        expect({ from, to, ok: canTransition(from, to) }).toEqual({
          from,
          to,
          ok: expected,
        });
      }
    }
  });

  it('CONFIRMED es final y FAILED solo vuelve a PENDING (reintento manual)', () => {
    for (const to of CHAIN_TX_STATUSES) {
      expect(canTransition('CONFIRMED', to)).toBe(false);
    }
    expect(CHAIN_TX_STATUSES.filter((s) => canTransition('FAILED', s))).toEqual(
      ['PENDING'],
    );
    expect(() => assertTransition('CONFIRMED', 'PENDING')).toThrow(
      InvalidChainTxTransition,
    );
    expect(() => assertTransition('PENDING', 'SUBMITTED')).toThrow(
      /PENDING → SUBMITTED/,
    );
  });
});

describe('Reintentos (S-4) e idempotencia en la red', () => {
  const delays = CHAIN_DEFAULTS.txRetryDelaysMs;
  const now = new Date('2026-10-09T12:00:00.000Z');

  it('6 intentos con esperas de 10 s, 30 s, 1 min, 2 min y 5 min', () => {
    expect(maxAttempts(delays)).toBe(6);
    expect(
      [1, 2, 3, 4, 5].map((attempts) => {
        const decision = decideRetry(attempts, delays, now);
        return decision.retry ? decision.delayMs : null;
      }),
    ).toEqual([10_000, 30_000, 60_000, 120_000, 300_000]);
    const first = decideRetry(1, delays, now);
    expect(first.retry && first.nextAttemptAt.toISOString()).toBe(
      '2026-10-09T12:00:10.000Z',
    );
  });

  it('agotados los intentos (o sin haber intentado) no hay reintento', () => {
    expect(decideRetry(6, delays, now)).toEqual({ retry: false });
    expect(decideRetry(7, delays, now)).toEqual({ retry: false });
    expect(decideRetry(0, delays, now)).toEqual({ retry: false });
    expect(decideRetry(1, [], now)).toEqual({ retry: false });
  });

  it('una enviada sin respuesta solo se reconstruye pasado su maxTime', () => {
    const maxTime = new Date('2026-10-09T12:02:00.000Z');
    const at = (iso: string) => new Date(iso);
    expect(canRebuildAfterNotFound(maxTime, at('2026-10-09T12:01:59Z'))).toBe(
      false,
    );
    // Margen: la red puede cerrar el ledger de ese segundo algo después
    expect(canRebuildAfterNotFound(maxTime, at('2026-10-09T12:02:03Z'))).toBe(
      false,
    );
    expect(canRebuildAfterNotFound(maxTime, at('2026-10-09T12:02:06Z'))).toBe(
      true,
    );
    // Nunca se envió (sin maxTime): se puede construir
    expect(canRebuildAfterNotFound(null, now)).toBe(true);
  });
});

describe('Clasificación de errores (contrato O3 §2.3 y §9)', () => {
  it('transitorios y definitivos', () => {
    for (const code of [
      'CHN_RPC_UNAVAILABLE',
      'CHN_TX_TIMEOUT',
      'CHN_BAD_SEQUENCE',
      'CHN_INSUFFICIENT_FEE',
      'CHN_TRY_AGAIN_LATER',
      'CHN_ARCHIVED_ENTRY',
    ]) {
      expect(isTransientChainTxError(code)).toBe(true);
    }
    for (const code of [
      'CHN_CONTRACT_ERROR',
      'CHN_AUTH_FAILED',
      'CHN_INSUFFICIENT_BALANCE',
      'CHN_INTENT_REJECTED',
      'CHN_MINT_DISABLED',
    ]) {
      expect(isTransientChainTxError(code)).toBe(false);
    }
    expect(new ChainTxFailure('CHN_BAD_SEQUENCE').retryable).toBe(true);
    expect(new IntentRejected('no cuadra')).toMatchObject({
      code: 'CHN_INTENT_REJECTED',
      retryable: false,
      detail: 'no cuadra',
    });
  });

  it('códigos de resultado de la red al enviar', () => {
    const code = (result: string) => failureFromTxResultCode(result).code;
    expect(code('txBadSeq')).toBe('CHN_BAD_SEQUENCE');
    expect(code('txInsufficientFee')).toBe('CHN_INSUFFICIENT_FEE');
    expect(code('txTooLate')).toBe('CHN_TX_TIMEOUT');
    expect(code('txBadAuth')).toBe('CHN_AUTH_FAILED');
    expect(code('txBadAuthExtra')).toBe('CHN_AUTH_FAILED');
    expect(code('txInsufficientBalance')).toBe('CHN_INSUFFICIENT_BALANCE');
    expect(code('txMalformed')).toBe('CHN_CONTRACT_ERROR');
    expect(failureFromTxResultCode('txBadSeq').detail).toBe('txBadSeq');
  });

  it('error de un contrato: código en `meta.contractErrorCode` (simulación y JSON del XDR)', () => {
    const simulated = failureFromDiagnostics(
      'HostError: Error(Contract, #1000)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Contract, #1000)]',
    );
    expect(simulated).toMatchObject({
      code: 'CHN_CONTRACT_ERROR',
      retryable: false,
      meta: { contractErrorCode: 1000 },
      detail: 'HostError: Error(Contract, #1000)',
    });
    const onChain = failureFromDiagnostics(
      '{"result":{"tx_failed":[{"op_inner":{"invoke_host_function":"trapped"}}]}}\n{"event":{"body":{"v0":{"topics":[{"symbol":"error"},{"error":{"contract":207}}]}}}}',
    );
    expect(onChain.meta).toEqual({ contractErrorCode: 207 });
  });

  it('una autorización inválida manda sobre el error del contrato que la exigía', () => {
    expect(
      failureFromDiagnostics(
        'HostError: Error(Auth, InvalidAction)\n... Error(Contract, #2000)',
      ).code,
    ).toBe('CHN_AUTH_FAILED');
    expect(
      failureFromDiagnostics('{"error":{"auth":"invalid_action"}}').code,
    ).toBe('CHN_AUTH_FAILED');
  });

  it('entradas archivadas, presupuesto y saldo', () => {
    expect(
      failureFromDiagnostics(
        '{"tx_failed":[{"op_inner":{"invoke_host_function":"entry_archived"}}]}',
      ),
    ).toMatchObject({ code: 'CHN_ARCHIVED_ENTRY', retryable: true });
    expect(
      failureFromDiagnostics('HostError: Error(Budget, ExceededLimit)').code,
    ).toBe('CHN_INSUFFICIENT_FEE');
    expect(
      failureFromDiagnostics(
        '{"tx_failed":[{"op_inner":{"create_account":"underfunded"}}]}',
      ).code,
    ).toBe('CHN_INSUFFICIENT_BALANCE');
    expect(
      failureFromDiagnostics(
        '{"tx_failed":[{"op_inner":{"create_account":"already_exist"}}]}',
      ).code,
    ).toBe('CHN_CONTRACT_ERROR');
  });

  it('el detalle se acota a una línea (va al historial)', () => {
    const failure = failureFromDiagnostics(`\n\n${'x'.repeat(900)}\notra`);
    expect(failure.detail).toHaveLength(300);
  });
});

describe('ChainTxRef y ChainTransaction (contrato O3 §2.3)', () => {
  const EXPLORER = 'https://stellar.expert/explorer/testnet';

  it('explorerUrl lo construye el backend y solo cuando hay hash', () => {
    expect(toChainTxRef(row(), EXPLORER)).toMatchObject({
      status: 'PENDING',
      txHash: null,
      explorerUrl: null,
      lastError: null,
      attempts: 0,
    });
    expect(toChainTxRef(row({ txHash: HASH }), EXPLORER).explorerUrl).toBe(
      `${EXPLORER}/tx/${HASH}`,
    );
    // Red local: sin explorador
    expect(toChainTxRef(row({ txHash: HASH }), null).explorerUrl).toBeNull();
  });

  it('lastError con su código, mensaje y si se reintenta solo', () => {
    const ref = toChainTxRef(
      row({
        status: 'RETRYING',
        lastError: {
          code: 'CHN_BAD_SEQUENCE',
          message: 'El número de secuencia ya se usó',
          retryable: true,
          meta: { interno: true },
        },
      }),
      EXPLORER,
    );
    expect(ref.lastError).toEqual({
      code: 'CHN_BAD_SEQUENCE',
      message: 'El número de secuencia ya se usó',
      retryable: true,
    });
  });

  it('la transacción completa: importes como texto, historial en orden y sin datos de más', () => {
    const attempt = (
      status: string,
      seconds: number,
      extra: Partial<ChainTxAttempt> = {},
    ): ChainTxAttempt => ({
      id: `${status}-${seconds}`,
      transactionId: row().id,
      attempt: 1,
      status,
      at: new Date(Date.UTC(2026, 9, 9, 12, 0, seconds)),
      txHash: null,
      sequence: null,
      errorCode: null,
      detail: null,
      ...extra,
    });
    const view = toChainTransaction(
      {
        ...row({
          status: 'CONFIRMED',
          txHash: HASH,
          ledger: 1234,
          confirmedAt: new Date('2026-10-09T12:00:07.000Z'),
          attempts: 1,
          sourceAccount: ACCOUNT,
          signers: [
            { role: 'OPERATIONS', address: ACCOUNT, wineryId: null },
            { role: 'WINERY', address: ACCOUNT, secret: 'no debe salir' },
            'basura',
          ] as never,
          feeChargedStroops: 1_389_000n,
          rentFeeStroops: 2564n,
          maxFeeStroops: 100_000_000n,
          result: { returnValue: 99, contractEvents: ['lot_minted', 7] },
          requestedByUserId: 'u-1',
          requestedByName: 'Lic. Marcos Vaca',
          requestedSource: 'API',
        }),
        attemptsLog: [
          attempt('CONFIRMED', 7, { txHash: HASH }),
          attempt('BUILDING', 1),
          attempt('SUBMITTED', 2, { txHash: HASH, sequence: '42' }),
        ],
      },
      EXPLORER,
    );
    expect(view).toMatchObject({
      feeChargedStroops: '1389000',
      rentFeeStroops: '2564',
      maxFeeStroops: '100000000',
      sourceAccount: ACCOUNT,
      result: { returnValue: 99, contractEvents: ['lot_minted'] },
      requestedBy: {
        userId: 'u-1',
        fullName: 'Lic. Marcos Vaca',
        source: 'API',
      },
      abandoned: null,
    });
    expect(view.signers).toEqual([
      { role: 'OPERATIONS', address: ACCOUNT, wineryId: null },
      { role: 'WINERY', address: ACCOUNT, wineryId: null },
    ]);
    expect(view.history.map((h) => h.status)).toEqual([
      'BUILDING',
      'SUBMITTED',
      'CONFIRMED',
    ]);
    expect(view.history[1]).toMatchObject({ sequence: '42', txHash: HASH });
  });

  it('abandonada: quién, cuándo y por qué', () => {
    const view = toChainTransaction(
      row({
        status: 'FAILED',
        abandonedAt: new Date('2026-10-09T13:00:00.000Z'),
        abandonedBy: 'Lic. Marcos Vaca',
        abandonReason: 'Intención duplicada',
      }),
      EXPLORER,
    );
    expect(view.abandoned).toEqual({
      at: '2026-10-09T13:00:00.000Z',
      by: 'Lic. Marcos Vaca',
      reason: 'Intención duplicada',
    });
    expect(view.history).toEqual([]);
  });

  it('stroops ↔ XLM con 7 decimales', () => {
    expect(stroopsToXlm(1_389_000n)).toBe('0.1389000');
    expect(stroopsToXlm(0n)).toBe('0.0000000');
    expect(stroopsToXlm(100_000_000_000n)).toBe('10000.0000000');
    expect(xlmToStroops('2')).toBe(20_000_000n);
    expect(xlmToStroops('0.5')).toBe(5_000_000n);
    expect(xlmToStroops('50.1234567')).toBe(501_234_567n);
    expect(stroopsToXlm(xlmToStroops('9873.45123'))).toBe('9873.4512300');
  });

  it('estado del saldo de una cuenta de la plataforma', () => {
    const min = xlmToStroops('50');
    expect(balanceStatus(null, min)).toBe('MISSING');
    expect(balanceStatus(min - 1n, min)).toBe('LOW');
    expect(balanceStatus(min, min)).toBe('OK');
  });
});

describe('Parámetros del contrato de una bodega (contrato O3 §3.1)', () => {
  it('name: nombre comercial recortado a 40 bytes en frontera de carácter', () => {
    expect(contractName('  Destilería Cinti Viejo ')).toBe(
      'Destilería Cinti Viejo',
    );
    const long = 'Bodega y Viñedos de la Concepción del Año Ñ';
    const name = contractName(long);
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(40);
    expect(long.startsWith(name)).toBe(true);
    // Nunca parte un carácter de varios bytes
    expect(truncateUtf8('ñññ', 5)).toBe('ññ');
    expect(truncateUtf8('a🍷b', 4)).toBe('a');
    expect(truncateUtf8('a🍷b', 5)).toBe('a🍷');
  });

  it('symbol: el prefijo de lote; base_uri: la ruta pública de sus NFT', () => {
    expect(contractSymbol(' cvj ')).toBe('CVJ');
    expect(() => contractSymbol('')).toThrow(RangeError);
    expect(() => contractSymbol('DEMASIADOLARGO')).toThrow(RangeError);
    expect(
      contractBaseUri('https://api.drinksonchain.com/', 'cinti-viejo'),
    ).toBe('https://api.drinksonchain.com/v1/public/nft/cinti-viejo/');
    expect(() =>
      contractBaseUri('https://api.drinksonchain.com', 'x'.repeat(200)),
    ).toThrow(/200 bytes/);
  });

  it('sal y dirección deterministas: las de la verificación de la pista SC', () => {
    // integracion/eventos/_red.json del repo de contratos (red local, 08-10)
    const wasmHash =
      'eb9f75b2a17117cab0c44d318ffd2f0f7642c488f56b31167998795ce22089d8';
    const wineryId = '00000000-0000-4000-8000-000000000001';
    const salt = contractSalt('local', wineryId, wasmHash);
    expect(salt).toHaveLength(32);
    expect(
      predictContractAddress(
        'Standalone Network ; February 2017',
        ACCOUNT,
        salt,
      ),
    ).toBe('CDQX4AKGU76O7GH7F6SXPWGQ7YAVQTYPUYCSER67PWHJA3M7GIF6LACH');
    // Otro entorno, otra bodega u otro código → otra dirección
    for (const other of [
      contractSalt('dev', wineryId, wasmHash),
      contractSalt('local', wineryId.replace(/1$/, '2'), wasmHash),
      contractSalt('local', wineryId, 'f'.repeat(64)),
    ]) {
      expect(other.equals(salt)).toBe(false);
    }
  });

  it('claves de idempotencia de las intenciones', () => {
    expect(intentKeys.wineryAccount('w')).toBe('identity:w:account');
    expect(intentKeys.wineryContract('w')).toBe('identity:w:contract');
    expect(intentKeys.pause('c', 'a')).toBe('pause:c:a');
    expect(intentKeys.unpause('c', 'a')).toBe('unpause:c:a');
    expect(intentKeys.fund('OPERATIONS', '2026-10-09')).toBe(
      'fund:OPERATIONS:2026-10-09',
    );
  });
});

describe('stellar.toml (SEP-1; contrato O3 §3.2)', () => {
  it('VERSION, NETWORK_PASSPHRASE, ACCOUNTS sin repetir y DOCUMENTATION', () => {
    const toml = buildStellarToml({
      networkPassphrase: 'Test SDF Network ; September 2015',
      accounts: [ACCOUNT, ACCOUNT, `G${'B'.repeat(55)}`],
      orgUrl: 'https://app.drinksonchain.com',
    });
    expect(toml).toBe(
      [
        'VERSION="2.7.0"',
        'NETWORK_PASSPHRASE="Test SDF Network ; September 2015"',
        'ACCOUNTS=[',
        `  "${ACCOUNT}",`,
        `  "G${'B'.repeat(55)}"`,
        ']',
        '',
        '[DOCUMENTATION]',
        'ORG_NAME="Drinks on Chain"',
        'ORG_URL="https://app.drinksonchain.com"',
        'ORG_DESCRIPTION="Trazabilidad y tokenización de bebidas de origen: cada bodega tiene su cuenta y su contrato NFT."',
        '',
      ].join('\n'),
    );
    // Los contratos no son activos: van en el registro JSON (S-7)
    expect(toml).not.toContain('CURRENCIES');
  });

  it('sin cuentas (cadena sin configurar) sigue siendo un documento válido', () => {
    const toml = buildStellarToml({
      networkPassphrase: 'Test SDF Network ; September 2015',
      accounts: [],
      orgUrl: null,
    });
    expect(toml).toContain('ACCOUNTS=[]');
    expect(toml).not.toContain('ORG_URL');
  });

  it('escapa comillas, barras y caracteres de control', () => {
    expect(tomlString('a"b\\c\nd')).toBe('"a\\"b\\\\c d"');
  });
});
