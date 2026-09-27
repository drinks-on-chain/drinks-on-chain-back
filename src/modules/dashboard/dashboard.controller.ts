import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  Audience,
  OrgType,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { DashboardService } from './dashboard.service';
import { DashboardDto } from './dto/dashboard.dto';

/** Tablero del back office (contrato O1 §8, PLT-06): todo el personal de plataforma. */
@ApiTags('Back office · Tablero')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Roles('SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT')
@Controller('platform/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({
    summary: 'Tablero del back office',
    description:
      'Solicitudes por estado, bodegas por estado, invitaciones pendientes y por caducar, miembros bloqueados, alertas y los 5 últimos eventos de la bitácora. Los bloques de tokenización, canjes y soporte se añaden en sus olas (cambio aditivo).',
  })
  @ApiOkResponse({ type: DashboardDto })
  @ApiUnauthorizedResponse({ description: 'Sin sesión' })
  @ApiForbiddenResponse({
    description:
      'AUTH_INSUFFICIENT_PERMISSIONS: sin la organización de plataforma activa',
    type: ApiErrorResponseDto,
  })
  get(): Promise<DashboardDto> {
    return this.dashboard.get();
  }
}
