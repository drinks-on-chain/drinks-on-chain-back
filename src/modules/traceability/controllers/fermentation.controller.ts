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
import { FermentationService } from '../services/fermentation.service';
import { CreateFermentationTankDto } from '../dto/create-fermentation-tank.dto';
import { CreateFermentationLogDto } from '../dto/create-fermentation-log.dto';
import { CreateEnologicalTreatmentDto } from '../dto/create-enological-treatment.dto';
import { QueryTanksDto } from '../dto/query-tanks.dto';
import {
  EnologicalTreatmentResponseDto,
  FermentationLogResponseDto,
} from '../dto/fermentation-records-response.dto';
import { FermentationTankResponseDto } from '../dto/fermentation-tank-response.dto';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';

@ApiTags('Vinificación y Fermentación')
@ApiBearerAuth()
@PlatformReadOnly()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('fermentation-tanks')
export class FermentationController {
  constructor(private readonly fermentationService: FermentationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Registrar nueva cuba de fermentación',
    description:
      'Llena un tanque con pesajes de un mismo lote (contrato O2 §4.1): dictamen exigido por la instantánea (EA-04), kilos ≤ disponibles, llenado ≤ capacidad, fecha no anterior al ingreso ni futura, código físico libre (S-7). Uva sin lote y sin `lotId`/`newLot`: se crea el lote del tanque. `destinationType` predeclara la bifurcación: coherente con el lote y, si es singani, con la D.O. calculada (EA-03).',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Cuba de fermentación registrada',
    type: FermentationTankResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR · TRC_PHYTO_NOT_APPROVED (un detalle por pesaje) · TRC_MIXED_LOTS · TRC_VOLUME_EXCEEDS_AVAILABLE · TRC_TANK_CAPACITY_EXCEEDED · TRC_DATE_BEFORE_PREVIOUS_STAGE · TRC_DATE_IN_FUTURE · TRC_HARVEST_YEAR_MISMATCH · TRC_DESTINATION_MISMATCH · TRC_DO_NOT_ELIGIBLE · TRC_PRODUCT_NOT_SUPPORTED',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description: 'TRC_TANK_CODE_IN_USE · TRC_INVALID_STAGE · TRC_LOT_TERMINAL',
  })
  async createTank(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFermentationTankDto,
  ) {
    return this.fermentationService.createTank(
      wineryId,
      { id: user.id, role: user.role },
      dto,
    );
  }

  @Get()
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Listar cubas de fermentación',
    description:
      'Retorna las cubas de fermentación activas con filtros por estado y lote de vendimia.',
  })
  @ApiPaginatedResponse(FermentationTankResponseDto, {
    description: 'Página de cubas de fermentación',
  })
  async findTanks(
    @TenantId() wineryId: string | undefined,
    @Query() query: QueryTanksDto,
  ) {
    return this.fermentationService.findTanks(wineryId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Obtener detalle de una cuba de fermentación',
    description:
      'Retorna los datos de la cuba junto con su historial de lecturas térmicas y tratamientos enológicos.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Detalle de la cuba',
    type: FermentationTankResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Cuba no encontrada' })
  async findTankById(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.fermentationService.findTankById(wineryId, id);
  }

  @Post(':id/logs')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR')
  @ApiOperation({
    summary: 'Registrar lectura de control de fermentación (append-only)',
    description:
      'Agrega un registro térmico, de densidad y observaciones cualitativas. Solo en FILLING, FERMENTING o COMPLETED (409 `TRC_TANK_NOT_ACTIVE`); `recordedAt` entre el inicio del tanque y ahora (§4.4).',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description: 'TRC_TANK_NOT_ACTIVE · TRC_LOT_TERMINAL',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Log térmico registrado',
    type: FermentationLogResponseDto,
  })
  async addLog(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFermentationLogDto,
  ) {
    return this.fermentationService.addLog(wineryId, id, user.id, dto);
  }

  @Post(':id/treatments')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Registrar tratamiento enológico autorizado',
    description:
      'Registra la aplicación de un aditivo o corrector enológico con autorización SENASAG.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Tratamiento enológico registrado',
    type: EnologicalTreatmentResponseDto,
  })
  async addTreatment(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEnologicalTreatmentDto,
  ) {
    return this.fermentationService.addTreatment(wineryId, id, user.id, dto);
  }
}
