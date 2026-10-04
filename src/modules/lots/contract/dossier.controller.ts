import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { DossierService } from '@modules/lots/dossier.service';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiPlatformReadOnly,
  ApiRuleErrors,
} from './contract-responses';
import {
  CANONICAL_DOSSIER_SCHEMA,
  CloseDossierDto,
  DossierPreviewDto,
  LotDossierDto,
} from './dto/dossier.dto';

const MEMBER_ROLES = [
  'OWNER',
  'ENOLOGIST',
  'AGRONOMIST',
  'OPERATOR',
  'ACCOUNTANT',
] as const;

/** Expediente del lote y hash canónico (contrato O2 §10). */
@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('lots')
export class DossierController {
  constructor(private readonly dossier: DossierService) {}

  @Get(':id/dossier/preview')
  @Roles(...MEMBER_ROLES)
  @ApiOperation({
    summary: 'Requisitos del cierre del expediente',
    description:
      'Contrato O2 §10: `BOTTLED`, `LAB_CONFORMING`, `BOTTLE_CODES_READY`, `NO_OPEN_COMPLIANCE_ISSUES` y ' +
      '`NO_OPEN_SOURCES`. `hashPreview` es la huella del contenido canónico actual (el de ' +
      '`GET …/dossier/canonical`, con `closedAt` y `closedBy` en `null`): no cambia mientras no cambien los ' +
      'registros del lote; la huella definitiva incluye además la fecha y el autor del cierre. `null` si el ' +
      'lote aún no está embotellado; con el expediente cerrado, la huella definitiva.',
  })
  @ApiOkResponse({ type: DossierPreviewDto })
  @ApiLotNotFound()
  preview(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DossierPreviewDto> {
    return this.dossier.preview(wineryId, id);
  }

  @Post(':id/dossier/close')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Cerrar el expediente del lote',
    description:
      'Contrato O2 §10: calcula el hash SHA-256 del contenido canónico (JCS) y la raíz Merkle de los códigos ' +
      'de botella activos, pasa el lote a `CERTIFIED` y emite `lot.certified` por el outbox (la Ola 3 lo ' +
      'ancla). Tras el cierre el lote solo admite anular códigos sin sustituto.',
  })
  @ApiOkResponse({ type: LotDossierDto })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_DOSSIER_CLOSED',
    'TRC_LOT_TERMINAL',
  ])
  @ApiRuleErrors(['TRC_DOSSIER_NOT_READY (un detalle por requisito)'])
  close(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() _dto: CloseDossierDto,
  ): Promise<LotDossierDto> {
    return this.dossier.close(wineryId, id, user.id);
  }

  @Get(':id/dossier')
  @Roles(...MEMBER_ROLES)
  @ApiOperation({
    summary: 'Expediente del lote',
    description:
      'Contrato O2 §10: estado, hash, algoritmo, cierre y raíz Merkle de los códigos de botella. `anchor` es ' +
      '`null` hasta la Ola 3.',
  })
  @ApiOkResponse({ type: LotDossierDto })
  @ApiLotNotFound()
  get(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LotDossierDto> {
    return this.dossier.get(wineryId, id);
  }

  @Get(':id/dossier/canonical')
  @Roles(...MEMBER_ROLES)
  @ApiOperation({
    summary: 'Contenido canónico del expediente',
    description:
      'Contrato O2 §10: los **bytes exactos** que se hashearon (o se hashearían), sin el envoltorio `data`, ' +
      'para recalcular la huella. La cabecera `X-Dossier-Status` dice si el expediente está `OPEN` (vista ' +
      'previa) o `CLOSED`, y `X-Dossier-Hash` lleva el SHA-256 de estos bytes.',
  })
  @ApiProduces('application/json')
  @ApiOkResponse({
    description: 'JSON canónico (`doc-dossier/1`)',
    content: { 'application/json': { schema: CANONICAL_DOSSIER_SCHEMA } },
  })
  @ApiLotNotFound()
  async canonical(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const dossier = await this.dossier.canonical(wineryId, id);
    const name = (dossier.lotCode ?? dossier.reference).replace(
      /[^A-Za-z0-9._-]+/g,
      '-',
    );
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="expediente-${name}.json"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Dossier-Status', dossier.status);
    res.setHeader('X-Dossier-Hash', dossier.hash);
    res.end(Buffer.from(dossier.canonical, 'utf8'));
  }
}
