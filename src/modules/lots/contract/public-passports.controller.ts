import {
  Controller,
  Get,
  HttpStatus,
  Param,
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
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '@modules/auth/decorators/public.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { AppException } from '@shared/exceptions/app.exception';
import {
  PASSPORT_CACHE_CONTROL_CERTIFIED,
  PASSPORT_NOT_FOUND_CACHE_CONTROL,
  PassportResponse,
  PublicPassportService,
} from '../passport/public-passport.service';
import { ApiErrorCodes } from './contract-responses';
import { CANONICAL_DOSSIER_SCHEMA } from './dto/dossier.dto';
import {
  PublicBottlePassportDto,
  PublicLotPassportDto,
} from './dto/public-passports.dto';

const CACHE_NOTE =
  'Sin sesión. Límite: 60 peticiones/min por IP real (`X-DOC-Client-IP` del proxy firmado); más de 20 códigos ' +
  'inexistentes en 10 min → 429 `PUB_TOO_MANY_LOOKUPS` con `Retry-After`. `Cache-Control: public, max-age=60, ' +
  'stale-while-revalidate=600` y `ETag` (lote `CERTIFIED`: `max-age=3600`; el de una botella se queda en 60 s ' +
  'porque su código se puede anular). Los 404 se cachean 30 s.';

/** 429 del freno a la enumeración de códigos (§12.4, S-24). */
const ApiTooManyLookups = () =>
  ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    type: ApiErrorResponseDto,
    description: 'PUB_TOO_MANY_LOOKUPS',
    headers: {
      'Retry-After': {
        description: 'Segundos hasta poder reintentar',
        schema: { type: 'integer' },
      },
    },
  });

const LOT_CODE_PARAM = {
  name: 'lotCode',
  description: 'Código de lote de la etiqueta',
  example: 'CVJ-2026-SINGANI-004',
};

/**
 * Pasaporte público de lotes y botellas (contrato O2 §12): solo datos
 * registrados (§12.3), sin nombres de personas ni cifras internas.
 */
@ApiTags('Público')
@ApiExtraModels(PublicLotPassportDto, PublicBottlePassportDto)
@Controller('public')
export class PublicPassportsController {
  constructor(private readonly passports: PublicPassportService) {}

  /**
   * Ejecuta una consulta del pasaporte y pone sus cabeceras de caché: las de
   * la respuesta si va bien; `max-age=30` en el 404 y `no-store` en el resto
   * de errores (un 429 o un 422 no se guardan en ninguna caché).
   */
  private async cached<T>(
    res: Response,
    work: () => Promise<PassportResponse<T>>,
  ): Promise<T> {
    try {
      const result = await work();
      res.setHeader('Cache-Control', result.cacheControl);
      res.setHeader('ETag', result.etag);
      return result.body;
    } catch (error) {
      res.setHeader('Cache-Control', errorCacheControl(error));
      throw error;
    }
  }

  @Public()
  @Get('passports/:code')
  @ApiOperation({
    summary: 'Resolver un código del visor',
    description:
      'Contrato O2 §12.1: `PublicBottlePassport` (`kind: BOTTLE`) si es un código de botella válido (8 ' +
      'caracteres Crockford con control, normalizado: mayúsculas, sin espacios ni guiones, O → 0, I/L → 1), ' +
      `\`PublicLotPassport\` (\`kind: LOT\`) si es un código de lote. ${CACHE_NOTE}`,
  })
  @ApiParam({
    name: 'code',
    description: 'Código de botella (`K7M2Q9XA` o `K7M2-Q9XA`) o de lote',
    example: 'K7M2Q9XA',
  })
  @ApiOkResponse({
    description: 'Pasaporte de botella o de lote (discriminado por `kind`)',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(PublicBottlePassportDto) },
        { $ref: getSchemaPath(PublicLotPassportDto) },
      ],
      discriminator: {
        propertyName: 'kind',
        mapping: {
          BOTTLE: getSchemaPath(PublicBottlePassportDto),
          LOT: getSchemaPath(PublicLotPassportDto),
        },
      },
    },
  })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['PUB_CODE_NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, ['PUB_CODE_MALFORMED'])
  @ApiTooManyLookups()
  passport(
    @Param('code') code: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicBottlePassportDto | PublicLotPassportDto> {
    return this.cached(res, () => this.passports.resolve(code, clientIp(req)));
  }

  @Public()
  @Get('lots/:lotCode')
  @ApiOperation({
    summary: 'Pasaporte público de un lote',
    description: `Contrato O2 §12.2: solo lotes embotellados (con \`lotCode\`). ${CACHE_NOTE}`,
  })
  @ApiParam(LOT_CODE_PARAM)
  @ApiOkResponse({ type: PublicLotPassportDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['PUB_CODE_NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, ['PUB_CODE_MALFORMED'])
  @ApiTooManyLookups()
  lot(
    @Param('lotCode') lotCode: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicLotPassportDto> {
    return this.cached(res, () => this.passports.lot(lotCode, clientIp(req)));
  }

  @Public()
  @Get('bottles/:code')
  @ApiOperation({
    summary: 'Pasaporte público de una botella',
    description:
      'Contrato O2 §12.2: número de serie, estado del código (`VOIDED` = anulado por la bodega), prueba ' +
      `Merkle (con el expediente cerrado) y el pasaporte del lote. ${CACHE_NOTE}`,
  })
  @ApiParam({ name: 'code', example: 'K7M2Q9XA' })
  @ApiOkResponse({ type: PublicBottlePassportDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['PUB_CODE_NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, ['PUB_CODE_MALFORMED'])
  @ApiTooManyLookups()
  bottle(
    @Param('code') code: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicBottlePassportDto> {
    return this.cached(res, () => this.passports.bottle(code, clientIp(req)));
  }

  @Public()
  @Get('lots/:lotCode/dossier')
  @ApiOperation({
    summary: 'Expediente canónico público de un lote',
    description:
      'Contrato O2 §12.1 y §10: bytes canónicos del expediente (solo `CLOSED`), sin el envoltorio `data`, para ' +
      'recalcular la huella SHA-256. Los códigos de botella no van en claro (raíz Merkle con sal por botella).',
  })
  @ApiParam(LOT_CODE_PARAM)
  @ApiProduces('application/json')
  @ApiOkResponse({
    description: 'JSON canónico (`doc-dossier/1`)',
    content: { 'application/json': { schema: CANONICAL_DOSSIER_SCHEMA } },
  })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, [
    'PUB_CODE_NOT_FOUND (lote inexistente o expediente sin cerrar)',
  ])
  @ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, ['PUB_CODE_MALFORMED'])
  @ApiTooManyLookups()
  async dossier(
    @Param('lotCode') lotCode: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const dossier = await this.passports.dossier(lotCode, clientIp(req));
      // Los bytes exactos que se hashearon: sin envoltorio ni reserializar
      res.status(HttpStatus.OK);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', PASSPORT_CACHE_CONTROL_CERTIFIED);
      res.setHeader('ETag', `"${dossier.hash}"`);
      res.send(Buffer.from(dossier.canonical, 'utf8'));
    } catch (error) {
      res.setHeader('Cache-Control', errorCacheControl(error));
      throw error;
    }
  }

  @Public()
  @Get('lots/:lotCode/attachments/:attachmentId')
  @ApiOperation({
    summary: 'Descargar un adjunto público del lote',
    description:
      'Contrato O2 §12.1: redirección `302` a una URL firmada de corta vida (solo adjuntos `PUBLIC`).',
  })
  @ApiParam(LOT_CODE_PARAM)
  @ApiResponse({
    status: HttpStatus.FOUND,
    description: 'Redirección a la URL firmada del archivo',
    headers: {
      Location: {
        description: 'URL firmada de corta vida',
        schema: { type: 'string', format: 'uri' },
      },
    },
  })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, [
    'PUB_CODE_NOT_FOUND (lote o adjunto inexistente, o adjunto privado)',
  ])
  @ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, ['PUB_CODE_MALFORMED'])
  @ApiTooManyLookups()
  async attachment(
    @Param('lotCode') lotCode: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const url = await this.passports.attachmentUrl(
        lotCode,
        attachmentId,
        clientIp(req),
      );
      // La URL firmada caduca: la redirección no se guarda en ninguna caché
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(HttpStatus.FOUND, url);
    } catch (error) {
      res.setHeader('Cache-Control', errorCacheControl(error));
      throw error;
    }
  }
}

/** IP real del visitante: la firmada por el proxy de las apps o la de la conexión. */
function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

function errorCacheControl(error: unknown): string {
  return error instanceof AppException && error.statusCode === 404
    ? PASSPORT_NOT_FOUND_CACHE_CONTROL
    : 'no-store';
}
