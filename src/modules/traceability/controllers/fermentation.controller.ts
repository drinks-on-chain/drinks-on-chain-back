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
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { FermentationService } from '../services/fermentation.service';
import { CreateFermentationTankDto } from '../dto/create-fermentation-tank.dto';
import { CreateFermentationLogDto } from '../dto/create-fermentation-log.dto';
import { CreateEnologicalTreatmentDto } from '../dto/create-enological-treatment.dto';
import { QueryTanksDto } from '../dto/query-tanks.dto';
import { FermentationTankResponseDto } from '../dto/fermentation-tank-response.dto';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { Roles } from '@modules/auth/decorators/roles.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { UserRoleEnum } from '@prisma/client';

@ApiTags('Vinificación y Fermentación')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('fermentation-tanks')
export class FermentationController {
  constructor(private readonly fermentationService: FermentationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST)
  @ApiOperation({
    summary: 'Registrar nueva cuba de fermentación',
    description:
      'Asocia una cuba o tanque de acero inox a un lote de vendimia recibido.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Cuba de fermentación registrada',
    type: FermentationTankResponseDto,
  })
  async createTank(
    @TenantId() wineryId: string,
    @Body() dto: CreateFermentationTankDto,
  ) {
    return this.fermentationService.createTank(wineryId, dto);
  }

  @Get()
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.ENOLOGIST,
    UserRoleEnum.AGRONOMIST,
  )
  @ApiOperation({
    summary: 'Listar cubas de fermentación',
    description:
      'Retorna las cubas de fermentación activas con filtros por estado y lote de vendimia.',
  })
  async findTanks(
    @TenantId() wineryId: string | undefined,
    @Query() query: QueryTanksDto,
  ) {
    return this.fermentationService.findTanks(wineryId, query);
  }

  @Get(':id')
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.ENOLOGIST,
    UserRoleEnum.AGRONOMIST,
  )
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
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.ENOLOGIST,
    UserRoleEnum.POS_OPERATOR,
  )
  @ApiOperation({
    summary: 'Registrar lectura de control de fermentación (append-only)',
    description:
      'Agrega un registro térmico, de densidad y observaciones cualitativas.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Log térmico registrado',
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
  @Roles(UserRoleEnum.ENOLOGIST, UserRoleEnum.WINERY_ADMIN)
  @ApiOperation({
    summary: 'Registrar tratamiento enológico autorizado',
    description:
      'Registra la aplicación de un aditivo o corrector enológico con autorización SENASAG.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Tratamiento enológico registrado',
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
