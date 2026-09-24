import {
  Controller,
  Get,
  Post,
  Patch,
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
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { HarvestBatchesService } from './harvest-batches.service';
import { CreateHarvestBatchDto } from './dto/create-harvest-batch.dto';
import { UpdatePhytoStatusDto } from './dto/update-phyto-status.dto';
import { QueryHarvestBatchesDto } from './dto/query-harvest-batches.dto';
import { HarvestBatchResponseDto } from './dto/harvest-batch-response.dto';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { Roles } from '@modules/auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { UserRoleEnum } from '@prisma/client';

@ApiTags('Vendimia y Pesaje')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('harvest-batches')
export class HarvestBatchesController {
  constructor(private readonly harvestBatchesService: HarvestBatchesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.AGRONOMIST,
    UserRoleEnum.ENOLOGIST,
  )
  @ApiOperation({
    summary: 'Registrar ingreso y pesaje de uva en vendimia',
    description:
      'Registra el pesaje neto, parámetros de madurez (°Bx, pH, acidez) y asigna un código único al lote de vendimia.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lote de vendimia registrado',
    type: HarvestBatchResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Peso bruto menor o igual a tara' })
  @ApiNotFoundResponse({ description: 'Parcela no encontrada en esta bodega' })
  async create(
    @TenantId() wineryId: string,
    @Body() dto: CreateHarvestBatchDto,
  ) {
    return this.harvestBatchesService.create(wineryId, dto);
  }

  @Get()
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.ENOLOGIST,
    UserRoleEnum.AGRONOMIST,
  )
  @ApiOperation({
    summary: 'Listar lotes de vendimia',
    description: 'Obtiene el listado de lotes de vendimia con soporte de filtros por año y estado fitosanitario.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Listado de lotes de vendimia',
  })
  async findAll(
    @TenantId() wineryId: string | undefined,
    @Query() query: QueryHarvestBatchesDto,
  ) {
    return this.harvestBatchesService.findAll(wineryId, query);
  }

  @Get(':id')
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.ENOLOGIST,
    UserRoleEnum.AGRONOMIST,
  )
  @ApiOperation({
    summary: 'Obtener detalle de un lote de vendimia',
    description: 'Retorna los datos de pesaje, análisis de madurez y tanques de fermentación asociados.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Detalle del lote de vendimia',
    type: HarvestBatchResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Lote de vendimia no encontrado' })
  async findById(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.harvestBatchesService.findById(wineryId, id);
  }

  @Patch(':id/phyto-status')
  @Roles(UserRoleEnum.AGRONOMIST, UserRoleEnum.ENOLOGIST)
  @ApiOperation({
    summary: 'Dictaminar estado fitosanitario del lote',
    description:
      'Actualiza el estado fitosanitario (APPROVED, REJECTED, QUARANTINE) con soporte de adjunto PDF.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Estado fitosanitario actualizado',
    type: HarvestBatchResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Lote de vendimia no encontrado' })
  async updatePhytoStatus(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePhytoStatusDto,
  ) {
    return this.harvestBatchesService.updatePhytoStatus(
      wineryId,
      id,
      user.id,
      dto,
    );
  }
}
