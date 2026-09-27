import { Controller, ForbiddenException, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { getRequestContext } from '@shared/context/request-context';
import { SettingsService } from './settings.service';
import { EffectiveSettingDto } from './dto/effective-setting.dto';

/**
 * Valor efectivo de la configuración para la organización activa (contrato
 * O1 §6, solo lectura). La edición (estándar, ajustes por bodega, historial)
 * llega con el back office en la Ola 1 (`/v1/platform/settings/*`).
 */
@ApiTags('Configuración')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('organizations/current/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Configuración efectiva de mi bodega',
    description:
      'Valor efectivo de cada parámetro para la bodega activa: su ajuste si existe (source WINERY) o el estándar general (source GLOBAL). No paginada: son menos de 50.',
  })
  @ApiOkResponse({ type: EffectiveSettingDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'Sin sesión' })
  @ApiForbiddenResponse({ description: 'Sin una bodega activa' })
  async getCurrent(): Promise<EffectiveSettingDto[]> {
    const ctx = getRequestContext();
    if (!ctx?.organizationId || ctx.organizationType !== 'WINERY') {
      throw new ForbiddenException(
        'La configuración efectiva es de una bodega: no hay una bodega activa',
      );
    }
    return this.settings.effectiveAll(ctx.organizationId);
  }
}
