import * as Joi from 'joi';
import type { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import {
  CHAIN_DEFAULTS,
  assertChainEnvCoherent,
  chainEnvValidationSchema,
  chainSettingsFromConfig,
  isMasterSeedFormat,
  normalizeChainNetwork,
} from '../chain.config';
import {
  explorerAccountUrl,
  explorerContractUrl,
  explorerTxUrl,
  memoHashFromHex,
} from '../explorer';

const schema = Joi.object(chainEnvValidationSchema).custom(
  assertChainEnvCoherent,
);
const validate = (env: Record<string, unknown>) =>
  schema.validate(env, { allowUnknown: true, abortEarly: false });

const settingsOf = (env: Record<string, unknown>) =>
  chainSettingsFromConfig({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

const ACCOUNT = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';

describe('Variables de la cadena (contrato O3 §2.1)', () => {
  it('todas son opcionales: sin ninguna, valida y la cadena queda deshabilitada', () => {
    const { error, value } = validate({});
    expect(error).toBeUndefined();
    expect(value.STELLAR_NETWORK).toBe('TESTNET');
    expect(value.CHAIN_MINT_ENABLED).toBe(false);

    const settings = settingsOf({});
    expect(settings).toEqual({
      enabled: false,
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: null,
      explorerBaseUrl: 'https://stellar.expert/explorer/testnet',
      homeDomain: null,
      wasmHash: null,
      custodyDriver: null,
      mintEnabled: false,
      txMaxFeeStroops: CHAIN_DEFAULTS.txMaxFeeStroops,
      operationsMinBalanceXlm: CHAIN_DEFAULTS.operationsMinBalanceXlm,
      anchorMinBalanceXlm: CHAIN_DEFAULTS.anchorMinBalanceXlm,
      wineryStartingBalanceXlm: '2',
      ttlExtendBelowDays: 30,
      consumerSeedCheckAddress: null,
      publicApiBaseUrl: null,
      deployMaxFeeStroops: '500000000',
      txRetryDelaysMs: [10_000, 30_000, 60_000, 120_000, 300_000],
      friendbotUrl: null,
      environment: 'testnet',
    });
  });

  it('paso 3.1: tope del despliegue, esperas de reintento, Friendbot y etiqueta del entorno', () => {
    const env = {
      STELLAR_NETWORK: 'LOCAL',
      CHAIN_DEPLOY_MAX_FEE_STROOPS: '900000000',
      CHAIN_TX_RETRY_DELAYS_MS: '500,1000',
      STELLAR_FRIENDBOT_URL: 'http://localhost:8000/friendbot',
      CHAIN_ENVIRONMENT: 'dev',
    };
    expect(validate(env).error).toBeUndefined();
    expect(settingsOf(env)).toMatchObject({
      deployMaxFeeStroops: '900000000',
      txRetryDelaysMs: [500, 1000],
      friendbotUrl: 'http://localhost:8000/friendbot',
      environment: 'dev',
    });
    // Sin etiqueta, la sal de los contratos lleva la red
    expect(settingsOf({ STELLAR_NETWORK: 'LOCAL' }).environment).toBe('local');
    for (const bad of [
      { CHAIN_TX_RETRY_DELAYS_MS: '10s,30s' },
      { CHAIN_DEPLOY_MAX_FEE_STROOPS: '-1' },
      { CHAIN_ENVIRONMENT: 'Dev Server' },
      { STELLAR_FRIENDBOT_URL: 'friendbot' },
    ]) {
      expect(validate(bad).error).toBeDefined();
    }
  });

  it('vacías (como las pasa docker compose) equivalen a no definirlas', () => {
    const empty = Object.fromEntries(
      Object.keys(chainEnvValidationSchema).map((key) => [key, '']),
    );
    const { error, value } = validate(empty);
    expect(error).toBeUndefined();
    expect(value.STELLAR_NETWORK).toBe('TESTNET');
    expect(settingsOf(empty).enabled).toBe(false);
    expect(settingsOf(empty).mintEnabled).toBe(false);
  });

  it('acepta los nombres de red de antes de la Ola 3 (compose pasaba `testnet`)', () => {
    expect(validate({ STELLAR_NETWORK: 'testnet' }).value.STELLAR_NETWORK).toBe(
      'TESTNET',
    );
    expect(normalizeChainNetwork('mainnet')).toBe('PUBLIC');
    expect(normalizeChainNetwork('standalone')).toBe('LOCAL');
    expect(normalizeChainNetwork(' Local ')).toBe('LOCAL');
    expect(validate({ STELLAR_NETWORK: 'futurenet' }).error?.message).toContain(
      'STELLAR_NETWORK debe ser TESTNET, PUBLIC o LOCAL',
    );
  });

  it('la cadena se habilita con custodio y RPC; la emisión sigue apagada por defecto (ADR-011)', () => {
    const env = {
      STELLAR_NETWORK: 'testnet',
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      CHAIN_CUSTODY_DRIVER: 'env',
      STELLAR_HOME_DOMAIN: 'api.ejemplo.com',
      WINERY_NFT_WASM_HASH: HASH,
      API_PUBLIC_URL: 'https://api.ejemplo.com/',
    };
    const { error, value } = validate(env);
    expect(error).toBeUndefined();
    expect(value.CHAIN_CUSTODY_DRIVER).toBe('ENV');
    expect(value.CHAIN_MINT_ENABLED).toBe(false);
    const settings = settingsOf({ ...env, ...value });
    expect(settings).toMatchObject({
      enabled: true,
      custodyDriver: 'ENV',
      mintEnabled: false,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      homeDomain: 'api.ejemplo.com',
      wasmHash: HASH,
      publicApiBaseUrl: 'https://api.ejemplo.com',
    });
    expect(settingsOf({ ...env, CHAIN_MINT_ENABLED: 'true' }).mintEnabled).toBe(
      true,
    );
    // Solo custodio o solo RPC no basta
    expect(settingsOf({ CHAIN_CUSTODY_DRIVER: 'LOCAL' }).enabled).toBe(false);
    expect(settingsOf({ STELLAR_RPC_URL: env.STELLAR_RPC_URL }).enabled).toBe(
      false,
    );
  });

  it('el custodio ENV no se admite en la red pública', () => {
    const { error } = validate({
      STELLAR_NETWORK: 'PUBLIC',
      CHAIN_CUSTODY_DRIVER: 'ENV',
    });
    expect(error?.message).toContain(
      'CHAIN_CUSTODY_DRIVER=ENV no se admite con STELLAR_NETWORK=PUBLIC',
    );
    expect(
      validate({ STELLAR_NETWORK: 'LOCAL', CHAIN_CUSTODY_DRIVER: 'ENV' }).error,
    ).toBeUndefined();
    // Los drivers de producción (D7) aún no existen
    expect(
      validate({ CHAIN_CUSTODY_DRIVER: 'AWS_KMS' }).error?.message,
    ).toContain('CHAIN_CUSTODY_DRIVER debe ser ENV o LOCAL');
  });

  it('valida el formato de lo que se define', () => {
    const bad: Record<string, unknown> = {
      STELLAR_RPC_URL: 'ftp://rpc',
      STELLAR_HOME_DOMAIN: 'https://api.ejemplo.com/ruta',
      WINERY_NFT_WASM_HASH: 'abc',
      CHAIN_TX_MAX_FEE_STROOPS: '-5',
      CHAIN_OPERATIONS_MIN_BALANCE_XLM: '1,5',
      CHAIN_TTL_EXTEND_BELOW_DAYS: 500,
      CHAIN_CONSUMER_SEED_CHECK_ADDRESS: 'G123',
    };
    const message = validate(bad).error?.message ?? '';
    for (const key of Object.keys(bad)) {
      expect(message).toContain(key);
    }
    expect(
      validate({
        STELLAR_HOME_DOMAIN: '136.243.223.39.sslip.io',
        CHAIN_TX_MAX_FEE_STROOPS: '50000000',
        CHAIN_OPERATIONS_MIN_BALANCE_XLM: '100.5',
        CHAIN_TTL_EXTEND_BELOW_DAYS: '45',
        CHAIN_CONSUMER_SEED_CHECK_ADDRESS: ACCOUNT,
      }).error,
    ).toBeUndefined();
  });

  it('los secretos se validan sin repetir su valor en el error', () => {
    const wrongSecret = 'SCLAVEQUENOESDESTELLAR';
    const wrongSeed = 'doce palabras no son';
    const { error } = validate({
      CHAIN_SECRET_OPERATIONS: wrongSecret,
      CHAIN_SECRET_ANCHOR: ACCOUNT,
      CHAIN_DEV_WINERY_SEED: wrongSeed,
      CHAIN_CONSUMER_MASTER_SEED: 'abcd',
    });
    const message = error?.message ?? '';
    for (const name of [
      'CHAIN_SECRET_OPERATIONS',
      'CHAIN_SECRET_ANCHOR',
      'CHAIN_DEV_WINERY_SEED',
      'CHAIN_CONSUMER_MASTER_SEED',
    ]) {
      expect(message).toContain(`${name} no tiene el formato esperado`);
    }
    for (const value of [wrongSecret, wrongSeed, ACCOUNT, 'abcd']) {
      expect(message).not.toContain(value);
    }
    expect(JSON.stringify(error?.details)).not.toContain(wrongSecret);

    expect(
      validate({
        CHAIN_SECRET_OPERATIONS: Keypair.random().secret(),
        CHAIN_SECRET_ANCHOR: Keypair.random().secret(),
        CHAIN_DEV_WINERY_SEED: MNEMONIC,
        CHAIN_CONSUMER_MASTER_SEED: 'ab'.repeat(64),
      }).error,
    ).toBeUndefined();
  });

  it('una semilla maestra es hexadecimal de 32–64 bytes o una frase de 12–24 palabras', () => {
    expect(isMasterSeedFormat('ab'.repeat(32))).toBe(true);
    expect(isMasterSeedFormat('ab'.repeat(64))).toBe(true);
    expect(isMasterSeedFormat('ab'.repeat(31))).toBe(false);
    // 45 bytes valen; un número impar de dígitos no es hexadecimal de bytes
    expect(isMasterSeedFormat('abc'.repeat(30))).toBe(true);
    expect(isMasterSeedFormat('abc'.repeat(23))).toBe(false);
    expect(isMasterSeedFormat(MNEMONIC)).toBe(true);
    expect(isMasterSeedFormat('una dos tres')).toBe(false);
  });

  it('los secretos nunca entran en ChainSettings', () => {
    const secret = Keypair.random().secret();
    const settings = settingsOf({
      CHAIN_CUSTODY_DRIVER: 'ENV',
      STELLAR_RPC_URL: 'https://rpc.ejemplo.com',
      CHAIN_SECRET_OPERATIONS: secret,
      CHAIN_SECRET_ANCHOR: secret,
      CHAIN_DEV_WINERY_SEED: MNEMONIC,
      CHAIN_CONSUMER_MASTER_SEED: MNEMONIC,
    });
    const dump = JSON.stringify(settings);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('illness');
  });

  it('la red local no tiene explorador por defecto y cada red tiene su frase', () => {
    expect(settingsOf({ STELLAR_NETWORK: 'LOCAL' })).toMatchObject({
      network: 'LOCAL',
      explorerBaseUrl: null,
      networkPassphrase: 'Standalone Network ; February 2017',
    });
    expect(settingsOf({ STELLAR_NETWORK: 'PUBLIC' })).toMatchObject({
      explorerBaseUrl: 'https://stellar.expert/explorer/public',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
    expect(
      settingsOf({
        STELLAR_NETWORK: 'LOCAL',
        STELLAR_NETWORK_PASSPHRASE: 'Red de pruebas',
        STELLAR_EXPLORER_BASE_URL: 'http://localhost:8000/explorer/',
      }),
    ).toMatchObject({
      networkPassphrase: 'Red de pruebas',
      explorerBaseUrl: 'http://localhost:8000/explorer',
    });
  });
});

describe('Enlaces al explorador y memo del anclaje (contrato O3 §0, §7.1)', () => {
  const base = 'https://stellar.expert/explorer/testnet';

  it('construye los enlaces de transacción, cuenta y contrato', () => {
    expect(explorerTxUrl(base, HASH)).toBe(`${base}/tx/${HASH}`);
    expect(explorerAccountUrl(`${base}/`, ACCOUNT)).toBe(
      `${base}/account/${ACCOUNT}`,
    );
    expect(explorerContractUrl(base, CONTRACT)).toBe(
      `${base}/contract/${CONTRACT}`,
    );
  });

  it('sin explorador, sin dato o con un dato que no lo es, no hay enlace', () => {
    expect(explorerTxUrl(null, HASH)).toBeNull();
    expect(explorerTxUrl(base, null)).toBeNull();
    expect(explorerTxUrl(base, 'no-es-un-hash')).toBeNull();
    // Una cuenta no es un contrato, ni al revés
    expect(explorerAccountUrl(base, CONTRACT)).toBeNull();
    expect(explorerContractUrl(base, ACCOUNT)).toBeNull();
  });

  it('el memo son los 32 bytes del hash: hex ↔ bytes ↔ base64', () => {
    const memo = memoHashFromHex(HASH.toUpperCase());
    expect(memo.hex).toBe(HASH);
    expect(memo.bytes).toHaveLength(32);
    expect(memo.base64).toBe('n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=');
    expect(Buffer.from(memo.base64, 'base64').toString('hex')).toBe(HASH);
    expect(() => memoHashFromHex('abc')).toThrow(RangeError);
  });
});
