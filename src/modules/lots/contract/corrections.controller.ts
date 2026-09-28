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
import { notImplemented } from '@modules/lots/domain/trace-errors';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiNotImplemented,
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
      'la instantánea y, si resuelve una incidencia, la marca `resolvedAt`. Solo quien tiene el rol para crear ' +
      'ese registro puede corregirlo (S-17).',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CorrectionDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_LOT_NOT_FOUND', 'NOT_FOUND'])
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_DOSSIER_CLOSED',
    'TRC_LOT_TERMINAL',
  ])
  @ApiRuleErrors([
    'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
    'TRC_CORRECTION_BREAKS_RULES',
  ])
  @ApiNotImplemented('2.7')
  create(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CreateLotCorrectionDto,
  ): CorrectionDto {
    throw notImplemented('2.7');
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
  @ApiNotImplemented('2.7')
  list(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
    @Query() _query: WineryScopedPaginationQueryDto,
  ): Paginated<CorrectionDto> {
    throw notImplemented('2.7');
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
  @ApiNotImplemented('2.7')
  create(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CreateTerroirCorrectionDto,
  ): CorrectionDto {
    throw notImplemented('2.7');
  }
}
