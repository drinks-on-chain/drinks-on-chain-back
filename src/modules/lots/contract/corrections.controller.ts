import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { CorrectionsService } from '@modules/traceability/services/corrections.service';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiPlatformReadOnly,
  ApiRuleErrors,
} from './contract-responses';
import {
  CorrectionDto,
  CreateLotCorrectionDto,
  CreateTerroirCorrectionDto,
} from './dto/corrections.dto';

/** Correcciones compensatorias de los registros del lote (contrato O2 §9). */
@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('lots')
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post(':id/corrections')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  // S-17: además, el servidor exige el rol que puede crear el registro corregido
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR')
  @ApiOperation({
    summary: 'Registrar una corrección compensatoria',
    description:
      'Contrato O2 §9: ningún registro se edita ni se borra; la corrección guarda el valor anterior y el nuevo ' +
      '(`AMEND`) o deja de contar el registro (`VOID`), con motivo. Vuelve a validar las reglas del lote con ' +
      'la instantánea (candados, balances, D.O.): si incumple una → 422 `TRC_CORRECTION_BREAKS_RULES` con los ' +
      'detalles de la regla y su `code`; si lo que incumple es una regla de un embotellado ya hecho (candado a ' +
      'su fecha, balance de volumen o de alcohol), la corrección se registra y abre una incidencia con ' +
      '`source: CORRECTION` que bloquea el cierre del expediente; si resuelve una incidencia, la marca ' +
      '`resolvedAt`. Solo quien tiene el rol para crear ese registro puede corregirlo (S-17; si no, 403 ' +
      '`AUTH_INSUFFICIENT_PERMISSIONS`). Las parcelas se corrigen con `POST /v1/terroirs/{id}/corrections`.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CorrectionDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, [
    'TRC_LOT_NOT_FOUND',
    'NOT_FOUND (el registro no existe en el lote)',
  ])
  @ApiErrorCodes(HttpStatus.FORBIDDEN, [
    'TRC_PLATFORM_READ_ONLY',
    'AUTH_INSUFFICIENT_PERMISSIONS (S-17)',
  ])
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_DOSSIER_CLOSED',
    'TRC_LOT_TERMINAL',
    'TRC_PHYTO_DECISION_FINAL (anular un dictamen con la uva en un tanque)',
    'TRC_INVALID_STAGE (fuente descartada)',
    'CONFLICT (registro ya anulado)',
  ])
  @ApiRuleErrors([
    'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
    'TRC_CORRECTION_BREAKS_RULES',
  ])
  create(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateLotCorrectionDto,
  ) {
    return this.corrections.createForLot(
      wineryId,
      { id: user.id, role: user.role },
      id,
      dto,
    );
  }

  @Get(':id/corrections')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Correcciones del lote',
    description:
      'Contrato O2 §9: todas las correcciones del lote con sus valores anteriores, la más reciente primero.',
  })
  @ApiPaginatedResponse(CorrectionDto, {
    description: 'Página de correcciones',
  })
  @ApiLotNotFound()
  list(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: WineryScopedPaginationQueryDto,
  ) {
    return this.corrections.listForLot(wineryId, id, query);
  }
}

/** Corrección de los campos normativos de una parcela usada (contrato O2 §3.1 y §9). */
@ApiTags('Terroirs y Parcelas')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('terroirs')
export class TerroirCorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post(':id/corrections')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'AGRONOMIST')
  @ApiOperation({
    summary: 'Corregir una parcela usada',
    description:
      'Contrato O2 §3.1 y §9: `altitudeMasl`, `varietyName` y `rawMaterialType` de una parcela con pesajes solo ' +
      'cambian por aquí. Reevalúa la D.O. de los lotes abiertos que la usan: si uno deja de cumplir, recibe una ' +
      'incidencia `TRC_DO_NOT_ELIGIBLE` con `source: RULES_REEVALUATION`. La corrección tiene `lotId: null`.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CorrectionDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['NOT_FOUND (parcela)'])
  @ApiPlatformReadOnly()
  @ApiRuleErrors([
    'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
    'TRC_CORRECTION_BREAKS_RULES',
  ])
  create(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTerroirCorrectionDto,
  ) {
    return this.corrections.createForTerroir(
      wineryId,
      { id: user.id, role: user.role },
      id,
      dto,
    );
  }
}
