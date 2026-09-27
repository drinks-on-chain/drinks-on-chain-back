import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthStatusDataDto,
  LivenessDataDto,
} from './dto/health-response.dto';
import { Public } from '@modules/auth/decorators/public.decorator';

@ApiTags('System')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  @SkipThrottle({ global: true })
  @ApiOperation({
    summary: 'Verificar el estado del servidor, base de datos y Redis',
    description:
      'Endpoint público para monitoreo y balanceadores de carga. Retorna el estado de conectividad con PostgreSQL y Redis.',
  })
  @ApiResponse({
    status: 200,
    description: 'Estado de salud obtenido exitosamente',
    type: HealthStatusDataDto,
  })
  async getHealth(): Promise<HealthStatusDataDto> {
    return this.healthService.checkHealth();
  }

  @Get('live')
  @Public()
  @SkipThrottle({ global: true })
  @ApiOperation({
    summary: 'Liveness: el proceso responde',
    description:
      'No consulta dependencias: sirve para saber si hay que reiniciar el proceso.',
  })
  @ApiResponse({ status: 200, type: LivenessDataDto })
  getLiveness(): LivenessDataDto {
    return this.healthService.liveness();
  }

  @Get('ready')
  @Public()
  @SkipThrottle({ global: true })
  @ApiOperation({
    summary: 'Readiness: base de datos, Redis y almacenamiento disponibles',
    description:
      'Responde 200 si puede atender tráfico y 503 (con el mismo cuerpo) si falta alguna dependencia.',
  })
  @ApiResponse({ status: 200, type: HealthStatusDataDto })
  @ApiResponse({
    status: 503,
    description: 'Alguna dependencia no está disponible',
    type: HealthStatusDataDto,
  })
  async getReadiness(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthStatusDataDto> {
    const { ready, health } = await this.healthService.checkReadiness();
    if (!ready) res.status(503);
    return health;
  }
}
