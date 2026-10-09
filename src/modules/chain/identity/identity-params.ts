import { createHash } from 'crypto';
import { Address, StrKey, hash, xdr } from '@stellar/stellar-sdk';
import {
  CONTRACT_BASE_URI_MAX_BYTES,
  CONTRACT_NAME_MAX_BYTES,
  CONTRACT_SYMBOL_MAX_BYTES,
} from '../chain.constants';

/**
 * Parámetros del contrato NFT de una bodega (contrato O3 §3.1; DS-13, DS-16).
 * Funciones puras: lo que se despliega se calcula siempre de los datos de la
 * bodega, nunca de un valor recibido de fuera.
 */

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** Recorta a `maxBytes` en frontera de carácter (nunca parte un carácter UTF-8). */
export function truncateUtf8(text: string, maxBytes: number): string {
  let result = '';
  let used = 0;
  for (const character of text) {
    const size = bytes(character);
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

/** `name` = nombre comercial recortado a 40 bytes (DS-13). */
export function contractName(tradeName: string): string {
  return truncateUtf8(tradeName.trim(), CONTRACT_NAME_MAX_BYTES).trim();
}

/** `symbol` = prefijo de lote (3–5 letras, único y definitivo; ≤ 10 bytes). */
export function contractSymbol(lotPrefix: string): string {
  const symbol = lotPrefix.trim().toUpperCase();
  if (symbol.length === 0 || bytes(symbol) > CONTRACT_SYMBOL_MAX_BYTES) {
    throw new RangeError(
      'El prefijo de lote no vale como símbolo del contrato',
    );
  }
  return symbol;
}

/** `base_uri` = `{API}/v1/public/nft/{slug}/` (≤ 200 bytes; `token_uri` = base + id). */
export function contractBaseUri(
  publicApiBaseUrl: string,
  slug: string,
): string {
  const uri = `${publicApiBaseUrl.replace(/\/+$/, '')}/v1/public/nft/${slug}/`;
  if (bytes(uri) > CONTRACT_BASE_URI_MAX_BYTES) {
    throw new RangeError('La URI base del contrato supera los 200 bytes');
  }
  return uri;
}

/** Sal determinista (S-2): `sha256("drinks-on-chain/winery-nft/{entorno}/{wineryId}/{wasmHash}")`. */
export function contractSalt(
  environment: string,
  wineryId: string,
  wasmHash: string,
): Buffer {
  return createHash('sha256')
    .update(`drinks-on-chain/winery-nft/${environment}/${wineryId}/${wasmHash}`)
    .digest();
}

/**
 * Dirección `C…` del contrato antes de desplegarlo (desplegador + sal): repetir
 * el despliegue se detecta sin estado propio.
 */
export function predictContractAddress(
  networkPassphrase: string,
  deployerAddress: string,
  salt: Buffer,
): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: Buffer.from(hash(Buffer.from(networkPassphrase))),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(deployerAddress).toScAddress(),
          salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(Buffer.from(hash(preimage.toXdr())));
}
