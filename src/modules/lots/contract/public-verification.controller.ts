import { Controller, Get, HttpStatus, Param, Req, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '@modules/auth/decorators/public.decorator';
import { PublicDossierVerificationDto } from '@modules/chain/dto/chain.dto';
import { ApiErrorCodes } from './contract-responses';
import {
  ApiTooManyLookups,
  clientIp,
  errorCacheControl,
} from './public-passports.controller';
import { PublicPassportService } from '../passport/public-passport.service';

/**
 * Público · verificación del anclaje de un lote (contrato O3 §7.3, PUB-03).
 * Vive con el pasaporte: mismo freno por IP, mismo 404 uniforme y misma caché.
 */
@ApiTags('Public')
@Controller('public')
export class PublicVerificationController {
  constructor(private readonly passports: PublicPassportService) {}

  @Public()
  @Get('lots/:lotCode/verification')
  @ApiOperation({
    summary: 'Verificación pública del anclaje de un lote',
    description:
      'Contrato O3 §7.3: huella del expediente, anclaje (memo y transacción) y las cuatro comprobaciones ' +
      '(`DOSSIER_CLOSED`, `ANCHOR_CONFIRMED`, `MEMO_MATCHES_HASH`, `ANCHOR_ACCOUNT_OFFICIAL`; `pass: null` = ' +
      'aún no aplica). Un anclaje fallido o a medias se publica como `PENDING`, sin transacción (S-17). ' +
      '`verifiedOnChainAt` es cuándo el servidor leyó la transacción y comprobó memo y cuenta de origen. El ' +
      'visor recalcula la huella en el navegador con los bytes de `GET /v1/public/lots/{lotCode}/dossier`. ' +
      'Sin sesión; mismo límite por IP real que el pasaporte (O2 §12.4); anclado: `max-age=3600`.',
  })
  @ApiParam({
    name: 'lotCode',
    description: 'Código de lote de la etiqueta',
    example: 'CVJ-2026-SINGANI-004',
  })
  @ApiOkResponse({ type: PublicDossierVerificationDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['PUB_CODE_NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, ['PUB_CODE_MALFORMED'])
  @ApiTooManyLookups()
  async verification(
    @Param('lotCode') lotCode: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicDossierVerificationDto> {
    try {
      const result = await this.passports.verification(lotCode, clientIp(req));
      res.setHeader('Cache-Control', result.cacheControl);
      res.setHeader('ETag', result.etag);
      return result.body;
    } catch (error) {
      res.setHeader('Cache-Control', errorCacheControl(error));
      throw error;
    }
  }
}
