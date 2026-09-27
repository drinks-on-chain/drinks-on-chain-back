import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  Audience,
  OrgType,
  RequireActiveOrg,
} from '@modules/auth/decorators/authorization.decorators';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { SettingsService } from './settings.service';
import { EffectiveSettingDto } from './dto/effective-setting.dto';

/**
 * Valor efectivo de la configuración para la bodega activa (contrato O1 §6,
 * solo lectura; todos los roles de la bodega). La edición está en el back
 * office (`PlatformSettingsController`, `/v1/platform/settings/*`). El
 * personal de plataforma puede consultarla con `?wineryId=` (OP-07).
 */
@ApiTags('Configuración')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('WINERY')
@Controller('organizations/current/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequireActiveOrg()
  @ApiOperation({
    summary: 'Configuración efectiva de mi bodega',
    description:
      'Valor efectivo de cada parámetro para la bodega activa: su ajuste si existe (source WINERY) o el estándar general (source GLOBAL). No paginada: son menos de 50.',
  })
  @ApiQuery({
    name: 'wineryId',
    required: false,
    schema: { type: 'string', format: 'uuid' },
    description:
      'Solo personal de plataforma: bodega consultada (obligatoria para ellos)',
  })
  @ApiOkResponse({ type: EffectiveSettingDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'Sin sesión' })
  @ApiForbiddenResponse({
    description:
      'AUTH_INSUFFICIENT_PERMISSIONS (sin una bodega activa) u ORG_NOT_ACTIVE (bodega no activa, SE-05)',
  })
  async getCurrent(
    @TenantId() wineryId: string | undefined,
  ): Promise<EffectiveSettingDto[]> {
    if (!wineryId) {
      // Personal de plataforma sin ?wineryId=
      throw ValidationException.forField(
        'wineryId',
        'Indica la bodega (?wineryId=) para ver su configuración efectiva',
      );
    }
    return this.settings.effectiveAll(wineryId);
  }
}
