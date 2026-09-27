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
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { LabAnalysesService } from '../services/lab-analyses.service';
import { CreateBatchLabAnalysisDto } from '../dto/create-batch-lab-analysis.dto';
import { BatchLabAnalysisResponseDto } from '../dto/batch-lab-analysis-response.dto';
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

@ApiTags('Laboratorio Físico-Químico')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('lab-analyses')
export class LabAnalysesController {
  constructor(private readonly labAnalysesService: LabAnalysesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.ENOLOGIST,
    UserRoleEnum.PLATFORM_ADMIN,
  )
  @ApiOperation({
    summary: 'Registrar informe analítico oficial de laboratorio',
    description:
      'Registra los parámetros físico-químicos (ABV, acidez, SO2, metanol, cobre) y dictamina conformidad SENASAG.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Informe de laboratorio registrado',
    type: BatchLabAnalysisResponseDto,
  })
  @ApiConflictResponse({
    description: 'El lote ya tiene un informe oficial registrado',
  })
  async create(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBatchLabAnalysisDto,
  ) {
    return this.labAnalysesService.create(wineryId, user.id, dto);
  }

  @Get('batch/:bottlingBatchId')
  @Roles(
    UserRoleEnum.WINERY_ADMIN,
    UserRoleEnum.ENOLOGIST,
    UserRoleEnum.AGRONOMIST,
    UserRoleEnum.PLATFORM_ADMIN,
    UserRoleEnum.CONSUMER,
  )
  @ApiOperation({
    summary:
      'Consultar certificado de laboratorio por ID de lote de embotellado',
    description:
      'Obtiene el informe físico-químico oficial emitido para un lote embotellado.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Informe analítico',
    type: BatchLabAnalysisResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Informe analítico no encontrado' })
  async findByBatchId(
    @TenantId() wineryId: string | undefined,
    @Param('bottlingBatchId', ParseUUIDPipe) bottlingBatchId: string,
  ) {
    return this.labAnalysesService.findByBatchId(wineryId, bottlingBatchId);
  }
}
