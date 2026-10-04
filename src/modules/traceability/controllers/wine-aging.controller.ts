import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { WineAgingService } from '../services/wine-aging.service';
import { CreateWineAgingBatchDto } from '../dto/create-wine-aging-batch.dto';
import { WineAgingResponseDto } from '../dto/wine-aging-response.dto';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';

@ApiTags('Crianza en Madera y Guarda (Vino)')
@ApiBearerAuth()
@PlatformReadOnly()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('wine-aging')
export class WineAgingController {
  constructor(private readonly wineAgingService: WineAgingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Iniciar lote de crianza en barricas',
    description:
      'Traslada el vino de un tanque `COMPLETED` con destino vino a su crianza (contrato O2 §5.1) y calcula el candado (`unlockDate`) con el mínimo de la instantánea del lote.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lote de crianza iniciado',
    type: WineAgingResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR (`volumeLiters` obligatorio) · TRC_AGING_BELOW_MINIMUM · TRC_VOLUME_EXCEEDS_AVAILABLE · TRC_DESTINATION_MISMATCH · TRC_DATE_IN_FUTURE · TRC_DATE_BEFORE_PREVIOUS_STAGE',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description:
      'FERMENTATION_TANK_ALREADY_TRANSFERRED · TRC_TANK_NOT_COMPLETED (tanque sin completar, ya transferido o limpio) · TRC_INVALID_STAGE · TRC_LOT_TERMINAL',
  })
  async createAgingBatch(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWineAgingBatchDto,
  ) {
    return this.wineAgingService.createAgingBatch(wineryId, user.id, dto);
  }

  @Get()
  @Roles('OWNER', 'ENOLOGIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Listar lotes de crianza',
    description: 'Obtiene el listado de barricas y lotes en guarda.',
  })
  @ApiPaginatedResponse(WineAgingResponseDto, {
    description: 'Página de lotes de crianza',
  })
  async findAll(
    @TenantId() wineryId: string | undefined,
    @Query() query: WineryScopedPaginationQueryDto,
  ) {
    return this.wineAgingService.findAll(wineryId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ENOLOGIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Obtener detalle de lote de crianza',
    description:
      'Retorna datos de barrica, meses planificados y fecha límite de bloqueo.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Detalle de crianza',
    type: WineAgingResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Lote de crianza no encontrado' })
  async findAgingBatchById(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.wineAgingService.findAgingBatchById(wineryId, id);
  }
}
