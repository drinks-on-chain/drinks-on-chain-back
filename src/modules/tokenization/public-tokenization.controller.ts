import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Public } from '@modules/auth/decorators/public.decorator';
import {
  ApiErrorCodes,
  ApiNotImplementedO3,
  notImplementedO3,
} from '@modules/chain/contract/o3-contract';
import { PublicNftMetadataDto } from './dto/public-nft.dto';

/** Ruta de la API que sirve una imagen pública de una colección (U-5). */
export const PUBLIC_COLLECTION_IMAGE_PATH = '/v1/public/collections/images';

/**
 * URL pública de una imagen de colección: `{API_PUBLIC_URL}/v1/public/collections/images/{id}`
 * (o la ruta relativa, que la app resuelve contra su proxy, si la API no
 * tiene origen público configurado). Es lo que llevan `CollectionImage.url` y
 * `coverImageUrl` de una colección publicada.
 */
export function publicCollectionImageUrl(
  publicApiBaseUrl: string | null,
  imageId: string,
): string {
  return `${publicApiBaseUrl ?? ''}${PUBLIC_COLLECTION_IMAGE_PATH}/${imageId}`;
}

/**
 * Público · metadatos de los NFT e imágenes de las colecciones (contrato O3
 * §6.5 y §5.5). Sin sesión y sin datos del consumidor.
 */
@ApiTags('Public')
@ApiExtraModels(PublicNftMetadataDto)
@Controller('public')
export class PublicTokenizationController {
  @Public()
  @Get('nft/:winerySlug/:tokenId')
  @ApiOperation({
    summary: 'Metadatos de un NFT (`token_uri`)',
    description:
      'Contrato O3 §6.5: lo que devuelve `token_uri(id)` del contrato de la bodega (URI base + id, sin ' +
      '`.json`). **Sin el envoltorio `{ data }`**: el cuerpo es el objeto de metadatos. Un token quemado sigue ' +
      'respondiendo, con `properties.status = BURNED`. `Cache-Control: public, max-age=300`; mismo límite por ' +
      'IP que el pasaporte.',
  })
  @ApiParam({ name: 'winerySlug', example: 'cinti-viejo' })
  @ApiParam({
    name: 'tokenId',
    schema: { type: 'integer', minimum: 0 },
    description: 'Id del token en el contrato de la bodega',
  })
  @ApiProduces('application/json')
  @ApiOkResponse({
    description: 'Metadatos del NFT, sin envoltorio',
    content: {
      'application/json': {
        schema: { $ref: getSchemaPath(PublicNftMetadataDto) },
      },
    },
  })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['PUB_TOKEN_NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.TOO_MANY_REQUESTS, ['TOO_MANY_REQUESTS'])
  @ApiNotImplementedO3('3.4')
  nftMetadata(
    @Param('winerySlug') _winerySlug: string,
    @Param('tokenId', ParseIntPipe) _tokenId: number,
  ): Promise<PublicNftMetadataDto> {
    throw notImplementedO3('3.4');
  }

  @Public()
  @Get('collections/images/:imageId')
  @ApiOperation({
    summary: 'Imagen pública de una colección',
    description:
      'Las imágenes de una colección son privadas hasta que se publica (contrato O3 §5.5); desde entonces las ' +
      'sirve la propia API, porque el almacenamiento de objetos no es público (U-5). Devuelve los bytes de la ' +
      'imagen (`image/jpeg`, `image/png`, `image/webp` o `image/gif`) con `Cache-Control: public, max-age=86400, ' +
      'immutable` y `ETag` (su SHA-256). Es la URL de `CollectionImage.url`, de `coverImageUrl` y de `image` ' +
      'en los metadatos del NFT. Una imagen de una colección sin publicar responde 404, como una inexistente.',
  })
  @ApiParam({
    name: 'imageId',
    format: 'uuid',
    description: '`CollectionImage.id`',
  })
  @ApiProduces('image/jpeg', 'image/png', 'image/webp', 'image/gif')
  @ApiOkResponse({
    description: 'Bytes de la imagen',
    content: {
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/webp': { schema: { type: 'string', format: 'binary' } },
      'image/gif': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['FILE_NOT_FOUND'])
  @ApiNotImplementedO3('3.4')
  collectionImage(
    @Param('imageId', ParseUUIDPipe) _imageId: string,
  ): Promise<void> {
    throw notImplementedO3('3.4');
  }
}
