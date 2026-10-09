import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Req,
  Res,
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
import type { Request, Response } from 'express';
import { AppException } from '@shared/exceptions/app.exception';
import { Public } from '@modules/auth/decorators/public.decorator';
import { ApiErrorCodes } from '@modules/chain/contract/o3-contract';
import { PublicNftMetadataDto } from './dto/public-nft.dto';
import {
  COLLECTION_IMAGE_CACHE_CONTROL,
  NFT_METADATA_CACHE_CONTROL,
  NFT_NOT_FOUND_CACHE_CONTROL,
  PublicTokenizationService,
} from './public-tokenization.service';

// Compatibilidad: la URL pública de las imágenes se definía aquí en la apertura
export {
  PUBLIC_COLLECTION_IMAGE_PATH,
  publicCollectionImageUrl,
} from './collection-images';

function errorCacheControl(error: unknown): string {
  return error instanceof AppException && error.statusCode === 404
    ? NFT_NOT_FOUND_CACHE_CONTROL
    : 'no-store';
}

/**
 * Público · metadatos de los NFT e imágenes de las colecciones (contrato O3
 * §6.5 y §5.5). Sin sesión y sin datos del consumidor.
 */
@ApiTags('Public')
@ApiExtraModels(PublicNftMetadataDto)
@Controller('public')
export class PublicTokenizationController {
  constructor(private readonly publicTokenization: PublicTokenizationService) {}

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
  async nftMetadata(
    @Param('winerySlug') winerySlug: string,
    @Param('tokenId', ParseIntPipe) tokenId: number,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const metadata = await this.publicTokenization.nftMetadata(
        winerySlug,
        tokenId,
        req.ip ?? null,
      );
      // Sin envoltorio: el cuerpo es el objeto de metadatos (`token_uri`)
      res.status(HttpStatus.OK);
      res.setHeader('Cache-Control', NFT_METADATA_CACHE_CONTROL);
      res.json(metadata);
    } catch (error) {
      res.setHeader('Cache-Control', errorCacheControl(error));
      throw error;
    }
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
  async collectionImage(
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const image = await this.publicTokenization.collectionImage(imageId);
      const etag = `"${image.sha256}"`;
      res.setHeader('Cache-Control', COLLECTION_IMAGE_CACHE_CONTROL);
      res.setHeader('ETag', etag);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers['if-none-match'] === etag) {
        res.status(HttpStatus.NOT_MODIFIED).end();
        return;
      }
      res.status(HttpStatus.OK);
      res.setHeader('Content-Type', image.mimeType);
      res.setHeader('Content-Length', String(image.body.length));
      res.send(image.body);
    } catch (error) {
      res.setHeader('Cache-Control', errorCacheControl(error));
      throw error;
    }
  }
}
