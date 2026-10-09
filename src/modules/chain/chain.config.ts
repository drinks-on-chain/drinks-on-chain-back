import * as Joi from 'joi';
import type { ConfigService } from '@nestjs/config';
import type { ChainNetwork } from './chain.constants';

/**
 * Configuración de la cadena (contrato O3 §2.1). **Todas las variables son
 * opcionales**: sin `CHAIN_CUSTODY_DRIVER` y `STELLAR_RPC_URL` la aplicación
 * arranca con la cadena deshabilitada (`ChainSettings.enabled = false`) y
 * ninguna intención sale a la red.
 *
 * Los secretos (`CHAIN_SECRET_*`, `CHAIN_DEV_WINERY_SEED`,
 * `CHAIN_CONSUMER_MASTER_SEED`) solo los lee el custodio `ENV`
 * (`custody/env-key-custody.ts`); nunca entran en `ChainSettings`, en un log
 * ni en un mensaje de error: sus validaciones no repiten el valor.
 */

export type CustodyDriver = 'ENV' | 'LOCAL';

const NETWORK_ALIASES: Record<string, ChainNetwork> = {
  TESTNET: 'TESTNET',
  PUBLIC: 'PUBLIC',
  MAINNET: 'PUBLIC',
  LOCAL: 'LOCAL',
  STANDALONE: 'LOCAL',
};

export const NETWORK_PASSPHRASES: Record<ChainNetwork, string> = {
  TESTNET: 'Test SDF Network ; September 2015',
  PUBLIC: 'Public Global Stellar Network ; September 2015',
  LOCAL: 'Standalone Network ; February 2017',
};

const DEFAULT_EXPLORER_BASE_URLS: Record<ChainNetwork, string | null> = {
  TESTNET: 'https://stellar.expert/explorer/testnet',
  PUBLIC: 'https://stellar.expert/explorer/public',
  LOCAL: null,
};

/** Valores por defecto (contrato O3 §3.1, §8.3; el resto, decisión de O3-BE-1). */
export const CHAIN_DEFAULTS = {
  /** 10 XLM: admite la extensión del código cuando le queden < 90 días (§2.2). */
  txMaxFeeStroops: '100000000',
  operationsMinBalanceXlm: '50',
  anchorMinBalanceXlm: '5',
  /** Reserva base más margen (S-6). */
  wineryStartingBalanceXlm: '2',
  /** S-20. */
  ttlExtendBelowDays: 30,
} as const;

/** Acepta también los nombres de antes de la Ola 3 (`testnet`, `mainnet`, `standalone`). */
export function normalizeChainNetwork(raw: unknown): ChainNetwork | null {
  if (typeof raw !== 'string') return null;
  return NETWORK_ALIASES[raw.trim().toUpperCase()] ?? null;
}

const STELLAR_SECRET_SEED = /^S[A-Z2-7]{55}$/;
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const XLM_AMOUNT = /^\d{1,12}(\.\d{1,7})?$/;
const STROOPS = /^[1-9]\d{0,18}$/;
const HOSTNAME =
  /^(?=.{1,255}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/i;

/**
 * Semilla maestra: 32–64 bytes en hexadecimal o una frase mnemónica BIP-39 de
 * 12 a 24 palabras (SEP-0005).
 */
export function isMasterSeedFormat(value: string): boolean {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    return (
      trimmed.length % 2 === 0 && trimmed.length >= 64 && trimmed.length <= 128
    );
  }
  const words = trimmed.split(/\s+/);
  return words.length >= 12 && words.length <= 24;
}

/** Validación de un secreto cuyo mensaje nunca repite el valor. */
const secret = (
  name: string,
  isValid: (value: string) => boolean,
  hint: string,
) =>
  Joi.string()
    .allow('')
    .optional()
    .custom((value: string, helpers) =>
      isValid(value)
        ? value
        : // El contexto del error lleva `value`: se sustituye para que el
          // secreto no viaje en `error.details`
          helpers.message(
            { custom: `${name} no tiene el formato esperado (${hint})` },
            { value: '[oculto]' },
          ),
    );

const optionalPattern = (name: string, pattern: RegExp, hint: string) =>
  Joi.string()
    .allow('')
    .optional()
    .pattern(pattern)
    .messages({ 'string.pattern.base': `${name}: ${hint}` });

const optionalUrl = () =>
  Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional();

/**
 * Fragmento Joi con las variables de la cadena: lo comparten la API
 * (`env.validation.ts`) y el worker (`worker.config.ts`).
 */
export const chainEnvValidationSchema = {
  // Vacía (como la pasa docker compose sin valor) = sin definir
  STELLAR_NETWORK: Joi.string()
    .empty('')
    .optional()
    .custom((value: string, helpers) => {
      const network = normalizeChainNetwork(value);
      return (
        network ??
        helpers.message({
          custom: 'STELLAR_NETWORK debe ser TESTNET, PUBLIC o LOCAL',
        })
      );
    })
    .default('TESTNET'),
  // Por defecto, la de la red elegida
  STELLAR_NETWORK_PASSPHRASE: Joi.string().allow('').max(200).optional(),
  STELLAR_RPC_URL: optionalUrl(),
  // Por defecto, stellar.expert de la red (sin explorador en LOCAL)
  STELLAR_EXPLORER_BASE_URL: optionalUrl(),
  STELLAR_HOME_DOMAIN: optionalPattern(
    'STELLAR_HOME_DOMAIN',
    HOSTNAME,
    'un nombre de host sin esquema ni ruta (p. ej. api.ejemplo.com)',
  ),
  WINERY_NFT_WASM_HASH: optionalPattern(
    'WINERY_NFT_WASM_HASH',
    HEX_64,
    'SHA-256 del código en hexadecimal (64 caracteres en minúsculas)',
  ),
  // LOCAL = claves en memoria (pruebas); ENV = variables del entorno (solo
  // testnet y red local). VAULT_TRANSIT y AWS_KMS llegan con D7
  CHAIN_CUSTODY_DRIVER: Joi.string()
    .empty('')
    .optional()
    .uppercase()
    .valid('ENV', 'LOCAL')
    .messages({
      'any.only': 'CHAIN_CUSTODY_DRIVER debe ser ENV o LOCAL',
    }),
  // ADR-011: la emisión sigue apagada hasta que se active a propósito
  CHAIN_MINT_ENABLED: Joi.boolean().empty('').optional().default(false),
  CHAIN_TX_MAX_FEE_STROOPS: optionalPattern(
    'CHAIN_TX_MAX_FEE_STROOPS',
    STROOPS,
    'entero positivo en stroops',
  ),
  CHAIN_OPERATIONS_MIN_BALANCE_XLM: optionalPattern(
    'CHAIN_OPERATIONS_MIN_BALANCE_XLM',
    XLM_AMOUNT,
    'importe en XLM con hasta 7 decimales',
  ),
  CHAIN_ANCHOR_MIN_BALANCE_XLM: optionalPattern(
    'CHAIN_ANCHOR_MIN_BALANCE_XLM',
    XLM_AMOUNT,
    'importe en XLM con hasta 7 decimales',
  ),
  CHAIN_WINERY_STARTING_BALANCE_XLM: optionalPattern(
    'CHAIN_WINERY_STARTING_BALANCE_XLM',
    XLM_AMOUNT,
    'importe en XLM con hasta 7 decimales',
  ),
  CHAIN_TTL_EXTEND_BELOW_DAYS: Joi.number()
    .empty('')
    .integer()
    .min(1)
    .max(119)
    .optional(),
  CHAIN_CONSUMER_SEED_CHECK_ADDRESS: optionalPattern(
    'CHAIN_CONSUMER_SEED_CHECK_ADDRESS',
    STELLAR_ACCOUNT,
    'una dirección G… de 56 caracteres',
  ),
  // Referencias a los secretos del custodio ENV
  CHAIN_SECRET_OPERATIONS: secret(
    'CHAIN_SECRET_OPERATIONS',
    (value) => STELLAR_SECRET_SEED.test(value),
    'una semilla S… de 56 caracteres',
  ),
  CHAIN_SECRET_ANCHOR: secret(
    'CHAIN_SECRET_ANCHOR',
    (value) => STELLAR_SECRET_SEED.test(value),
    'una semilla S… de 56 caracteres',
  ),
  CHAIN_DEV_WINERY_SEED: secret(
    'CHAIN_DEV_WINERY_SEED',
    isMasterSeedFormat,
    '32–64 bytes en hexadecimal o una frase de 12 a 24 palabras',
  ),
  CHAIN_CONSUMER_MASTER_SEED: secret(
    'CHAIN_CONSUMER_MASTER_SEED',
    isMasterSeedFormat,
    '32–64 bytes en hexadecimal o una frase de 12 a 24 palabras',
  ),
};

/**
 * Regla de conjunto: el custodio `ENV` guarda las claves en variables del
 * entorno y solo vale para testnet y la red local (decisión del 08-10-2026;
 * producción: D7). Se añade al esquema raíz con `.custom(...)`.
 */
export function assertChainEnvCoherent<T extends Record<string, unknown>>(
  value: T,
  helpers: Joi.CustomHelpers,
): T | Joi.ErrorReport {
  if (
    value.CHAIN_CUSTODY_DRIVER === 'ENV' &&
    value.STELLAR_NETWORK === 'PUBLIC'
  ) {
    return helpers.message({
      custom:
        'CHAIN_CUSTODY_DRIVER=ENV no se admite con STELLAR_NETWORK=PUBLIC: las claves en variables del entorno son solo para testnet y la red local',
    });
  }
  return value;
}

export interface ChainSettings {
  /** Hay custodio y RPC configurados: las intenciones pueden salir a la red. */
  enabled: boolean;
  network: ChainNetwork;
  networkPassphrase: string;
  rpcUrl: string | null;
  explorerBaseUrl: string | null;
  homeDomain: string | null;
  wasmHash: string | null;
  custodyDriver: CustodyDriver | null;
  /** ADR-011: con `false`, las emisiones quedan `PENDING` (`CHN_MINT_DISABLED`). */
  mintEnabled: boolean;
  txMaxFeeStroops: string;
  operationsMinBalanceXlm: string;
  anchorMinBalanceXlm: string;
  wineryStartingBalanceXlm: string;
  ttlExtendBelowDays: number;
  consumerSeedCheckAddress: string | null;
  /** Origen público de la API (`API_PUBLIC_URL`, de la Ola 2): URI base de los contratos e imágenes. */
  publicApiBaseUrl: string | null;
}

export const CHAIN_SETTINGS = Symbol('CHAIN_SETTINGS');

const text = (config: ConfigService, key: string): string | null => {
  const value = config.get<string | number | boolean>(key);
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

export function chainSettingsFromConfig(config: ConfigService): ChainSettings {
  const network =
    normalizeChainNetwork(text(config, 'STELLAR_NETWORK')) ?? 'TESTNET';
  const driver = text(config, 'CHAIN_CUSTODY_DRIVER')?.toUpperCase() ?? null;
  const custodyDriver: CustodyDriver | null =
    driver === 'ENV' || driver === 'LOCAL' ? driver : null;
  const rpcUrl = text(config, 'STELLAR_RPC_URL');
  const explorer =
    text(config, 'STELLAR_EXPLORER_BASE_URL') ??
    DEFAULT_EXPLORER_BASE_URLS[network];
  const ttl = Number(text(config, 'CHAIN_TTL_EXTEND_BELOW_DAYS'));
  return {
    enabled: custodyDriver !== null && rpcUrl !== null,
    network,
    networkPassphrase:
      text(config, 'STELLAR_NETWORK_PASSPHRASE') ??
      NETWORK_PASSPHRASES[network],
    rpcUrl,
    explorerBaseUrl: explorer ? explorer.replace(/\/+$/, '') : null,
    homeDomain: text(config, 'STELLAR_HOME_DOMAIN'),
    wasmHash: text(config, 'WINERY_NFT_WASM_HASH'),
    custodyDriver,
    mintEnabled: text(config, 'CHAIN_MINT_ENABLED')?.toLowerCase() === 'true',
    txMaxFeeStroops:
      text(config, 'CHAIN_TX_MAX_FEE_STROOPS') ??
      CHAIN_DEFAULTS.txMaxFeeStroops,
    operationsMinBalanceXlm:
      text(config, 'CHAIN_OPERATIONS_MIN_BALANCE_XLM') ??
      CHAIN_DEFAULTS.operationsMinBalanceXlm,
    anchorMinBalanceXlm:
      text(config, 'CHAIN_ANCHOR_MIN_BALANCE_XLM') ??
      CHAIN_DEFAULTS.anchorMinBalanceXlm,
    wineryStartingBalanceXlm:
      text(config, 'CHAIN_WINERY_STARTING_BALANCE_XLM') ??
      CHAIN_DEFAULTS.wineryStartingBalanceXlm,
    ttlExtendBelowDays:
      Number.isInteger(ttl) && ttl > 0
        ? ttl
        : CHAIN_DEFAULTS.ttlExtendBelowDays,
    consumerSeedCheckAddress: text(config, 'CHAIN_CONSUMER_SEED_CHECK_ADDRESS'),
    publicApiBaseUrl:
      text(config, 'API_PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
  };
}
