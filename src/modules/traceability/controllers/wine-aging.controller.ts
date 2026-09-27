import {
  Controller,
  Get,
  Post,
  Body,
  Param,
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
import { WineAgingService } from '../services/wine-aging.service';
import { CreateWineAgingBatchDto } from '../dto/create-wine-aging-batch.dto';
import { WineAgingResponseDto } from '../dto/wine-aging-response.dto';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { Roles } from '@modules/auth/decorators/roles.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { UserRoleEnum } from '@prisma/client';

@ApiTags('Crianza en Madera y Guarda (Vino)')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('wine-aging')
export class WineAgingController {
  constructor(private readonly wineAgingService: WineAgingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST)
  @ApiOperation({
    summary: 'Iniciar lote de crianza en barricas',
    description:
      'Traslada vino de cuba a barricas calculando automáticamente la fecha de bloqueo (lockUntilDate).',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lote de crianza iniciado',
    type: WineAgingResponseDto,
  })
  async createAgingBatch(
    @TenantId() wineryId: string,
    @Body() dto: CreateWineAgingBatchDto,
  ) {
    return this.wineAgingService.createAgingBatch(wineryId, dto);
  }

  @Get()
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST)
  @ApiOperation({
    summary: 'Listar lotes de crianza',
    description: 'Obtiene el listado de barricas y lotes en guarda.',
  })
  async findAll(@TenantId() wineryId: string | undefined) {
    return this.wineAgingService.findAll(wineryId);
  }

  @Get(':id')
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST)
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
