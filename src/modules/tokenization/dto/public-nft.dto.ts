import { ApiProperty } from '@nestjs/swagger';
import { WineryRefDto } from './collections.dto';
import { TOKEN_STATUSES, type TokenStatus } from '../tokenization.constants';

/**
 * Metadatos públicos de un NFT (contrato O3 §6.5; `docs-back/06` §2.3): lo que
 * devuelve `token_uri`. Forma habitual de los metadatos de NFT (`name`,
 * `description`, `image`, `external_url`, `attributes`), sin el envoltorio
 * `{ data }` y sin datos del consumidor.
 */

export class PublicNftAttributeDto {
  @ApiProperty({
    example: 'Bodega',
    description:
      'Bodega, Lote (referencia), Bebida, Añada, Botella n.º, Colección, Estado',
  })
  trait_type!: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    example: 'Destilería Cinti Viejo',
  })
  value!: string | number;
}

export class PublicNftPropertiesDto {
  @ApiProperty({ type: () => WineryRefDto })
  winery!: WineryRefDto;

  @ApiProperty({ example: 'CVJ-L2026-004' })
  lotReference!: string;

  @ApiProperty({ type: String, nullable: true })
  lotCode!: string | null;

  @ApiProperty({ type: 'integer', minimum: 1, example: 57 })
  bottleNumber!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    example: 100,
    description: 'La cuota vigente (cambia con las ampliaciones)',
  })
  collectionSize!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  tokenId!: number;

  @ApiProperty({
    example: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  })
  contract!: string;

  @ApiProperty({
    enum: TOKEN_STATUSES,
    enumName: 'TokenStatus',
    description: 'Un token quemado sigue respondiendo con `BURNED` (veracidad)',
  })
  status!: TokenStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '`{PASSPORT_BASE_URL}/b/{lotCode}` si el lote ya tiene código',
  })
  passportUrl!: string | null;
}

export class PublicNftMetadataDto {
  @ApiProperty({ example: 'Singani Preventa 2026 · Botella 57 de 100' })
  name!: string;

  @ApiProperty({
    description:
      'Descripción comercial o, sin colección publicada, un texto neutro con la bodega y el lote',
  })
  description!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Portada de la colección (`GET /v1/public/collections/images/{id}`)',
  })
  image!: string | null;

  @ApiProperty({
    description:
      'El pasaporte del lote si existe; si no, la ficha de la colección en el Marketplace',
  })
  external_url!: string;

  @ApiProperty({ type: () => PublicNftAttributeDto, isArray: true })
  attributes!: PublicNftAttributeDto[];

  @ApiProperty({ type: () => PublicNftPropertiesDto })
  properties!: PublicNftPropertiesDto;
}
