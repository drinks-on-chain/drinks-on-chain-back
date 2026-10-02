import {
  Body,
  Controller,
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
  ApiTags,
} from '@nestjs/swagger';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { ProductionBatchResponseDto } from '@modules/traceability/dto/production-batch-response.dto';
import { WineAgingResponseDto } from '@modules/traceability/dto/wine-aging-response.dto';
import { StageActionsService } from '@modules/traceability/services/stage-actions.service';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiPlatformReadOnly,
  ApiRuleErrors,
} from './contract-responses';
import {
  CloseDistillationDto,
  DiscardProductionBatchDto,
  DiscardWineAgingDto,
} from './dto/stage-actions.dto';

/** Acciones sobre la crianza del vino (contrato O2 §5.1). */
@ApiTags('Crianza en Madera y Guarda (Vino)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('wine-aging')
export class WineAgingActionsController {
  constructor(private readonly actions: StageActionsService) {}

  @Post(':id/discard')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Descartar una crianza',
    description:
      'Contrato O2 §5.1: `AGING | READY → DISCARDED`, con motivo. Una crianza descartada deja de contar como ' +
      'fuente abierta del embotellado (§6.2).',
  })
  @ApiOkResponse({ type: WineAgingResponseDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, [
    'NOT_FOUND (crianza inexistente o de otra bodega)',
  ])
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, ['TRC_INVALID_STAGE', 'TRC_LOT_TERMINAL'])
  @ApiRuleErrors(['TRC_VOLUME_EXCEEDS_AVAILABLE'])
  discard(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DiscardWineAgingDto,
  ) {
    return this.actions.discardAging(wineryId, user.id, id, dto);
  }
}

/** Cierre y descarte de la destilación del singani (contrato O2 §5.2). */
@ApiTags('Destilación y Procesos Especiales (Singani)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('production-batches')
export class ProductionActionsController {
  constructor(private readonly actions: StageActionsService) {}

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Cerrar una destilación con sus cortes',
    description:
      'Contrato O2 §5.2: **balance de masa** cabezas + corazón + colas (+ vinaza) ≤ `inputVolumeLiters`. ' +
      'Abre el reposo: `mandatoryRestUntil = processEndDate + rules.singani.minRestDays` (instantánea del lote) ' +
      'y `restStatus: RESTING` (`READY` si la fecha declarada ya cumple el reposo). Con todas las destilaciones ' +
      'cerradas, el lote pasa a `RESTING`.',
  })
  @ApiOkResponse({ type: ProductionBatchResponseDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, [
    'NOT_FOUND (destilación inexistente o de otra bodega)',
  ])
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_DISTILLATION_ALREADY_CLOSED',
    'TRC_INVALID_STAGE (descartada o embotellada)',
    'TRC_LOT_TERMINAL',
  ])
  @ApiRuleErrors([
    'TRC_MASS_BALANCE_EXCEEDED',
    'TRC_VOLUME_MISSING (sin volumen de entrada registrado)',
    'TRC_DATE_IN_FUTURE',
    'TRC_DATE_BEFORE_PREVIOUS_STAGE',
  ])
  close(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseDistillationDto,
  ) {
    return this.actions.closeDistillation(wineryId, user.id, id, dto);
  }

  @Post(':id/discard')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Descartar una destilación',
    description:
      'Contrato O2 §5.2: `→ DISCARDED`, con motivo. Deja de contar como fuente abierta del embotellado (§6.2).',
  })
  @ApiOkResponse({ type: ProductionBatchResponseDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, [
    'NOT_FOUND (destilación inexistente o de otra bodega)',
  ])
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, ['TRC_INVALID_STAGE', 'TRC_LOT_TERMINAL'])
  @ApiRuleErrors()
  discard(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DiscardProductionBatchDto,
  ) {
    return this.actions.discardDistillation(wineryId, user.id, id, dto);
  }
}
