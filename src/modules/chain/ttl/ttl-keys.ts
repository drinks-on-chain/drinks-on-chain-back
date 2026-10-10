import { Address, xdr } from '@stellar/stellar-sdk';
import { LEDGERS_PER_DAY, OWNERSHIP_BUCKET_SIZE } from '../chain.constants';

/**
 * Claves de ledger de un contrato `winery-nft` (contrato O3 §8.3; forma
 * confirmada por O3-SC-1 en `integracion/claves-ttl.json` del repo de
 * contratos). Todas son `ContractData` persistente salvo el código. Funciones
 * puras: las usan la tarea de TTL, su manejador y la conciliación.
 */

const contractData = (contractAddress: string, key: xdr.ScVal): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractAddress).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    }),
  );

const variant = (name: string, value: xdr.ScVal): xdr.ScVal =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), value]);

/** Instancia del contrato: metadatos, roles, contador y pausa. */
export const instanceKey = (contractAddress: string): xdr.LedgerKey =>
  contractData(contractAddress, xdr.ScVal.scvLedgerKeyContractInstance());

/** Código compartido por todos los contratos (`LedgerKey::ContractCode`). */
export const codeKey = (wasmHash: string): xdr.LedgerKey =>
  xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, 'hex') }),
  );

/** `["Owner", u32]`. */
export const ownerKey = (
  contractAddress: string,
  tokenId: number,
): xdr.LedgerKey =>
  contractData(contractAddress, variant('Owner', xdr.ScVal.scvU32(tokenId)));

/** `["OwnershipBucket", u32]`, con `u32 = id / 3200`. */
export const ownershipBucketKey = (
  contractAddress: string,
  bucket: number,
): xdr.LedgerKey =>
  contractData(
    contractAddress,
    variant('OwnershipBucket', xdr.ScVal.scvU32(bucket)),
  );

/** `["Balance", Address]`. */
export const balanceKey = (
  contractAddress: string,
  account: string,
): xdr.LedgerKey =>
  contractData(
    contractAddress,
    variant('Balance', new Address(account).toScVal()),
  );

export const bucketOf = (tokenId: number): number =>
  Math.floor(tokenId / OWNERSHIP_BUCKET_SIZE);

export interface MintedRange {
  firstTokenId: number;
  lastTokenId: number;
}

/**
 * Ids cuya entrada `Owner` puede existir en esta ola (corrección de §8.3):
 * OpenZeppelin infiere el dueño **hacia delante**, así que existen
 * `Owner(último id de cada emisión)` y, tras una quema o una entrega del id
 * `n`, `Owner(n − 1)` si ese id sigue vivo en la misma emisión. Las que no
 * existan en la red simplemente no aparecen al leer su TTL. No se incluye
 * ningún id quemado (S-21: `BurnedToken` no se extiende).
 */
export function ownerCandidateIds(
  ranges: readonly MintedRange[],
  burnedIds: readonly number[],
): number[] {
  const burned = new Set(burnedIds);
  const ids = new Set<number>();
  for (const range of ranges) {
    if (!burned.has(range.lastTokenId)) ids.add(range.lastTokenId);
    for (let id = range.firstTokenId + 1; id <= range.lastTokenId; id += 1) {
      if (burned.has(id) && !burned.has(id - 1)) ids.add(id - 1);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

export interface NamedLedgerKey {
  /** Para los logs y las alertas: `instance`, `Owner(99)`… */
  name: string;
  key: xdr.LedgerKey;
}

/** Entradas de datos de un contrato que la tarea de TTL recorre en esta ola. */
export function contractTtlKeys(input: {
  contractAddress: string;
  wineryAccount: string;
  ranges: readonly MintedRange[];
  burnedIds: readonly number[];
}): NamedLedgerKey[] {
  const { contractAddress } = input;
  const keys: NamedLedgerKey[] = [
    { name: 'instance', key: instanceKey(contractAddress) },
  ];
  const owners = ownerCandidateIds(input.ranges, input.burnedIds);
  for (const id of owners) {
    keys.push({ name: `Owner(${id})`, key: ownerKey(contractAddress, id) });
  }
  for (const bucket of [...new Set(owners.map(bucketOf))]) {
    keys.push({
      name: `OwnershipBucket(${bucket})`,
      key: ownershipBucketKey(contractAddress, bucket),
    });
  }
  if (input.ranges.length > 0) {
    keys.push({
      name: 'Balance(bodega)',
      key: balanceKey(contractAddress, input.wineryAccount),
    });
  }
  return keys;
}

export const keyXdr = (key: xdr.LedgerKey): string => key.toXDR('base64');

/** Días de vida que le quedan a una entrada (`null` si no existe). */
export function daysLeft(
  liveUntilLedger: number | null | undefined,
  latestLedger: number,
): number | null {
  if (liveUntilLedger === null || liveUntilLedger === undefined) return null;
  return (liveUntilLedger - latestLedger) / LEDGERS_PER_DAY;
}

/**
 * ¿De qué contrato es una clave? `CODE` para el código; la dirección `C…`
 * para una entrada de datos; `null` si no es ni lo uno ni lo otro. Lo usa la
 * validación de `RESTORE_ENTRIES`: solo se restauran entradas propias.
 */
export function ledgerKeyOwner(
  key: xdr.LedgerKey,
):
  | { type: 'CODE'; wasmHash: string }
  | { type: 'CONTRACT'; address: string }
  | null {
  const raw = key as unknown as {
    type: string;
    value: {
      hash?: Uint8Array | { value: Uint8Array };
      contract?: xdr.ScAddress;
    };
  };
  try {
    if (raw.type === 'contractCode' && raw.value.hash) {
      const { hash } = raw.value;
      const bytes = hash instanceof Uint8Array ? hash : hash.value;
      return { type: 'CODE', wasmHash: Buffer.from(bytes).toString('hex') };
    }
    if (raw.type === 'contractData' && raw.value.contract) {
      return {
        type: 'CONTRACT',
        address: Address.fromScAddress(raw.value.contract).toString(),
      };
    }
  } catch {
    return null;
  }
  return null;
}
