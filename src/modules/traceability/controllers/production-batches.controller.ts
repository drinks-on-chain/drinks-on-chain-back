import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
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
import { ProductionBatchesService } from '../services/production-batches.service';
import { CreateDistillationBatchDto } from '../dto/create-distillation-batch.dto';
import { QueryProductionBatchesDto } from '../dto/query-production-batches.dto';
import { ProductionBatchResponseDto } from '../dto/production-batch-response.dto';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { Roles } from '@modules/auth/decorators/roles.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { UserRoleEnum } from '@prisma/client';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';

@ApiTags('Destilación y Procesos Especiales (Singani)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('production-batches')
export class ProductionBatchesController {
  constructor(
    private readonly productionBatchesService: ProductionBatchesService,
  ) {}

  @Post('distillation')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST)
  @ApiOperation({
    summary: 'Registrar proceso de destilación de Singani',
    description:
      'Registra la destilación en alambique con balance de masa (cabeza, corazón, cola) y fija el reposo inerte obligatorio de 180 días.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Destilación registrada',
    type: ProductionBatchResponseDto,
  })
  async createDistillationBatch(
    @TenantId() wineryId: string,
    @Body() dto: CreateDistillationBatchDto,
  ) {
    return this.productionBatchesService.createDistillationBatch(wineryId, dto);
  }

  @Get(':id/rest-status')
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.ENOLOGIST,
    UserRoleEnum.PLATFORM_ADMIN,
  )
  @ApiOperation({
    summary: 'Verificar días de reposo inerte (D.O. Singani)',
    description:
      'Calcula días transcurridos y restantes respecto a la regla obligatoria de 180 días de reposo.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Estado de reposo inerte',
  })
  async getRestStatus(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.productionBatchesService.getRestStatus(wineryId, id);
  }

  @Get(':id')
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST)
  @ApiOperation({
    summary: 'Obtener detalle de lote de producción/destilación',
    description:
      'Retorna volúmenes de corte, parámetros térmicos y cuba de vino base de origen.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Detalle de producción',
    type: ProductionBatchResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Lote de producción no encontrado' })
  async findProductionBatchById(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.productionBatchesService.findProductionBatchById(wineryId, id);
  }

  @Get()
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST)
  @ApiOperation({
    summary: 'Listar lotes de destilación y producción',
    description:
      'Retorna los lotes de transformación con filtros por proceso y estado de reposo.',
  })
  @ApiPaginatedResponse(ProductionBatchResponseDto, {
    description: 'Página de lotes de destilación y producción',
  })
  async findAll(
    @TenantId() wineryId: string | undefined,
    @Query() query: QueryProductionBatchesDto,
  ) {
    return this.productionBatchesService.findAll(wineryId, query);
  }
}
