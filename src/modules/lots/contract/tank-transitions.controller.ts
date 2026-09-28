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
import { FermentationTankResponseDto } from '@modules/traceability/dto/fermentation-tank-response.dto';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiNotImplemented,
  ApiPlatformReadOnly,
  ApiRuleErrors,
} from './contract-responses';
import {
  CleanFermentationTankDto,
  CompleteFermentationTankDto,
  StartFermentationTankDto,
} from './dto/stage-actions.dto';

const TANK_NOT_FOUND = ['NOT_FOUND (tanque inexistente o de otra bodega)'];
const TRANSITION_CONFLICT = [
  'TRC_TANK_INVALID_TRANSITION (`meta: { from, to }`)',
  'TRC_LOT_TERMINAL',
];

/**
 * Transiciones del tanque de fermentación (contrato O2 §4.2): acciones, no
 * `PATCH`. `COMPLETED → TRANSFERRED` es automática (crianza o destilaciones).
 */
@ApiTags('Vinificación y Fermentación')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('fermentation-tanks')
export class TankTransitionsController {
  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Iniciar la fermentación',
    description: 'Contrato O2 §4.2: `FILLING → FERMENTING`.',
  })
  @ApiOkResponse({ type: FermentationTankResponseDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, TANK_NOT_FOUND)
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, TRANSITION_CONFLICT)
  @ApiRuleErrors(['TRC_DATE_IN_FUTURE', 'TRC_DATE_BEFORE_PREVIOUS_STAGE'])
  @ApiNotImplemented('2.3')
  start(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: StartFermentationTankDto,
  ): FermentationTankResponseDto {
    throw notImplemented('2.3');
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Completar la fermentación y decidir el destino',
    description:
      'Contrato O2 §4.2–§4.3: `FERMENTING → COMPLETED` con `finalVolumeLiters ≤ volumeFilledLiters`. ' +
      '**Bifurcación**: `destination` debe coincidir con el `productType` del lote (`WINE` ↔ `WINE_AGING`, ' +
      '`SINGANI` ↔ `SINGANI_DIST`); si el lote aún no tiene tipo, la primera bifurcación lo fija ' +
      '(`PRODUCT_DECIDED`). Destino singani: D.O. de todos los pesajes del lote con la instantánea.',
  })
  @ApiOkResponse({ type: FermentationTankResponseDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, TANK_NOT_FOUND)
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, TRANSITION_CONFLICT)
  @ApiRuleErrors([
    'TRC_DESTINATION_MISMATCH',
    'TRC_DO_NOT_ELIGIBLE',
    'TRC_VOLUME_EXCEEDS_AVAILABLE',
    'TRC_DATE_IN_FUTURE',
    'TRC_DATE_BEFORE_PREVIOUS_STAGE',
  ])
  @ApiNotImplemented('2.3')
  complete(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CompleteFermentationTankDto,
  ): FermentationTankResponseDto {
    throw notImplemented('2.3');
  }

  @Post(':id/clean')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Limpiar el tanque',
    description:
      'Contrato O2 §4.2: `TRANSFERRED → CLEANED`; libera el `tankCode` para otro tanque (S-7).',
  })
  @ApiOkResponse({ type: FermentationTankResponseDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, TANK_NOT_FOUND)
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [TRANSITION_CONFLICT[0]])
  @ApiRuleErrors(['TRC_DATE_IN_FUTURE', 'TRC_DATE_BEFORE_PREVIOUS_STAGE'])
  @ApiNotImplemented('2.3')
  clean(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CleanFermentationTankDto,
  ): FermentationTankResponseDto {
    throw notImplemented('2.3');
  }
}
