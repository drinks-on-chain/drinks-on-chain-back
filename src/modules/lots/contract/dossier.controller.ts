import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { notImplemented } from '@modules/lots/domain/trace-errors';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiNotImplemented,
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
  @Get(':id/dossier/preview')
  @Roles(...MEMBER_ROLES)
  @ApiOperation({
    summary: 'Requisitos del cierre del expediente',
    description:
      'Contrato O2 §10: `BOTTLED`, `LAB_CONFORMING`, `BOTTLE_CODES_READY`, `NO_OPEN_COMPLIANCE_ISSUES` y ' +
      '`NO_OPEN_SOURCES`, con la huella que tendría el expediente si se cerrara ahora.',
  })
  @ApiOkResponse({ type: DossierPreviewDto })
  @ApiLotNotFound()
  @ApiNotImplemented('2.8')
  preview(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
  ): DossierPreviewDto {
    throw notImplemented('2.8');
  }

  @Post(':id/dossier/close')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Cerrar el expediente del lote',
    description:
      'Contrato O2 §10: calcula el hash SHA-256 del contenido canónico (JCS), pasa el lote a `CERTIFIED` y ' +
      'emite `lot.certified` por el outbox (la Ola 3 lo ancla). Tras el cierre el lote solo admite anular ' +
      'códigos sin sustituto.',
  })
  @ApiOkResponse({ type: LotDossierDto })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_DOSSIER_CLOSED',
    'TRC_LOT_TERMINAL',
  ])
  @ApiRuleErrors(['TRC_DOSSIER_NOT_READY (un detalle por requisito)'])
  @ApiNotImplemented('2.8')
  close(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CloseDossierDto,
  ): LotDossierDto {
    throw notImplemented('2.8');
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
  @ApiNotImplemented('2.8')
  get(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
  ): LotDossierDto {
    throw notImplemented('2.8');
  }

  @Get(':id/dossier/canonical')
  @Roles(...MEMBER_ROLES)
  @ApiOperation({
    summary: 'Contenido canónico del expediente',
    description:
      'Contrato O2 §10: los **bytes exactos** que se hashearon (o se hashearían), sin el envoltorio `data`, ' +
      'para recalcular la huella.',
  })
  @ApiProduces('application/json')
  @ApiOkResponse({
    description: 'JSON canónico (`doc-dossier/1`)',
    content: { 'application/json': { schema: CANONICAL_DOSSIER_SCHEMA } },
  })
  @ApiLotNotFound()
  @ApiNotImplemented('2.8')
  canonical(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
  ): Record<string, unknown> {
    throw notImplemented('2.8');
  }
}
