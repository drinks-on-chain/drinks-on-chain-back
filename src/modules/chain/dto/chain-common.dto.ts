import { ApiProperty } from '@nestjs/swagger';
import {
  CHAIN_NETWORKS,
  CHAIN_TX_KINDS,
  CHAIN_TX_STATUSES,
  DOSSIER_ANCHOR_STATUSES,
  PUBLIC_ANCHOR_STATUSES,
  type ChainNetwork,
  type ChainTxKind,
  type ChainTxStatus,
  type DossierAnchorStatus,
  type PublicAnchorStatus,
} from '../chain.constants';

/**
 * Tipos de la cadena que se incrustan en otros dominios (contrato O3 §2.3 y
 * §7): el ERP y el Marketplace nunca listan transacciones; reciben
 * `ChainTxRef` dentro de la cuenta de la bodega, la solicitud, la colección y
 * el anclaje. Sin dependencias de otros módulos.
 */

const ADDRESS_EXAMPLE =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const HASH_EXAMPLE =
  '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

export class ChainTxErrorDto {
  @ApiProperty({
    example: 'CHN_MINT_DISABLED',
    description:
      'Código interno (§2.3): `CHN_RPC_UNAVAILABLE`, `CHN_TX_TIMEOUT`, `CHN_BAD_SEQUENCE`, `CHN_INSUFFICIENT_FEE`, ' +
      '`CHN_TRY_AGAIN_LATER`, `CHN_ARCHIVED_ENTRY`, `CHN_CONTRACT_ERROR`, `CHN_AUTH_FAILED`, ' +
      '`CHN_INSUFFICIENT_BALANCE`, `CHN_INTENT_REJECTED`, `CHN_MINT_DISABLED`, `CHN_NETWORK_RESET`',
  })
  code!: string;

  @ApiProperty({ example: 'La emisión está deshabilitada en este entorno' })
  message!: string;

  @ApiProperty({ description: 'El worker la reintenta solo' })
  retryable!: boolean;
}

/** Estado de una transacción tal como lo ven el ERP, el Backoffice y el Marketplace. */
export class ChainTxRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: CHAIN_TX_KINDS, enumName: 'ChainTxKind' })
  kind!: ChainTxKind;

  @ApiProperty({ enum: CHAIN_TX_STATUSES, enumName: 'ChainTxStatus' })
  status!: ChainTxStatus;

  @ApiProperty({ enum: CHAIN_NETWORKS, enumName: 'ChainNetwork' })
  network!: ChainNetwork;

  @ApiProperty({
    type: String,
    nullable: true,
    example: HASH_EXAMPLE,
    description: 'Hex de 64; se conoce al firmar',
  })
  txHash!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: `https://stellar.expert/explorer/testnet/tx/${HASH_EXAMPLE}`,
    description: 'Lo construye el backend (`STELLAR_EXPLORER_BASE_URL`)',
  })
  explorerUrl!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1234567 })
  ledger!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt!: string | null;

  @ApiProperty({ type: 'integer', minimum: 0, example: 1 })
  attempts!: number;

  @ApiProperty({ type: () => ChainTxErrorDto, nullable: true })
  lastError!: ChainTxErrorDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

/** Anclaje del expediente (§7.1): sustituye a `anchor: null` de la Ola 2. */
export class DossierAnchorDto {
  @ApiProperty({
    enum: DOSSIER_ANCHOR_STATUSES,
    enumName: 'DossierAnchorStatus',
  })
  status!: DossierAnchorStatus;

  @ApiProperty({ enum: CHAIN_NETWORKS, enumName: 'ChainNetwork' })
  network!: ChainNetwork;

  @ApiProperty({ example: ADDRESS_EXAMPLE, description: 'Cuenta de anclaje' })
  account!: string;

  @ApiProperty({
    example: HASH_EXAMPLE,
    description: 'SHA-256 del expediente (los 32 bytes del memo), en hex',
  })
  memoHashHex!: string;

  @ApiProperty({
    example: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
    description:
      'Los mismos 32 bytes en base64 (como los muestra un explorador)',
  })
  memoHashBase64!: string;

  @ApiProperty({ type: String, nullable: true, example: HASH_EXAMPLE })
  txHash!: string | null;

  @ApiProperty({ type: 'integer', nullable: true })
  ledger!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  anchoredAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  explorerUrl!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo el servidor leyó la transacción y comprobó memo y cuenta de origen',
  })
  verifiedAt!: string | null;

  @ApiProperty({ type: () => ChainTxRefDto })
  transaction!: ChainTxRefDto;
}

/** Anclaje en el pasaporte público (§7.3): `FAILED` se publica como `PENDING` (S-17). */
export class PublicDossierAnchorDto {
  @ApiProperty({
    enum: PUBLIC_ANCHOR_STATUSES,
    enumName: 'PublicDossierAnchorStatus',
  })
  status!: PublicAnchorStatus;

  @ApiProperty({ enum: CHAIN_NETWORKS, enumName: 'ChainNetwork' })
  network!: ChainNetwork;

  @ApiProperty({ example: ADDRESS_EXAMPLE })
  account!: string;

  @ApiProperty({ example: HASH_EXAMPLE })
  memoHashHex!: string;

  @ApiProperty({ example: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=' })
  memoHashBase64!: string;

  @ApiProperty({ type: String, nullable: true })
  txHash!: string | null;

  @ApiProperty({ type: 'integer', nullable: true })
  ledger!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  anchoredAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  explorerUrl!: string | null;
}
