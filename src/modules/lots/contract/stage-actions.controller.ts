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
import { notImplemented } from '@modules/lots/domain/trace-errors';
import { ProductionBatchResponseDto } from '@modules/traceability/dto/production-batch-response.dto';
import { WineAgingResponseDto } from '@modules/traceability/dto/wine-aging-response.dto';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiNotImplemented,
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
  @ApiNotImplemented('2.4')
  discard(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: DiscardWineAgingDto,
  ): WineAgingResponseDto {
    throw notImplemented('2.4');
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
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Cerrar una destilación con sus cortes',
    description:
      'Contrato O2 §5.2: **balance de masa** cabezas + corazón + colas (+ vinaza) ≤ `inputVolumeLiters`. ' +
      'Abre el reposo: `mandatoryRestUntil = processEndDate + rules.singani.minRestDays` (instantánea del lote) ' +
      'y `restStatus: RESTING`. Con todas las destilaciones cerradas, el lote pasa a `RESTING`.',
  })
  @ApiOkResponse({ type: ProductionBatchResponseDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, [
    'NOT_FOUND (destilación inexistente o de otra bodega)',
  ])
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_DISTILLATION_ALREADY_CLOSED',
    'TRC_LOT_TERMINAL',
  ])
  @ApiRuleErrors([
    'TRC_MASS_BALANCE_EXCEEDED',
    'TRC_DATE_IN_FUTURE',
    'TRC_DATE_BEFORE_PREVIOUS_STAGE',
  ])
  @ApiNotImplemented('2.4')
  close(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CloseDistillationDto,
  ): ProductionBatchResponseDto {
    throw notImplemented('2.4');
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
  @ApiNotImplemented('2.4')
  discard(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: DiscardProductionBatchDto,
  ): ProductionBatchResponseDto {
    throw notImplemented('2.4');
  }
}
