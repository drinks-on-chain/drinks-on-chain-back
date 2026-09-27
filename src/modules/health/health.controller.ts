import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { HealthStatusDataDto } from './dto/health-response.dto';
import { SkipThrottle } from '@nestjs/throttler';
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
}
