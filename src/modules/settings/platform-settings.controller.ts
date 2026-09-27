import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  Audience,
  OrgType,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { CurrentUser } from '@shared/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { PaginationQueryDto, toPage } from '@shared/dto/pagination-query.dto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { RequiresReason } from '@shared/audit/requires-reason';
import { SettingsService } from './settings.service';
import {
  ResetSettingOverridesDto,
  SetSettingOverridesDto,
  SettingDefinitionDto,
  SettingHistoryEntryDto,
  SettingOverrideDto,
  SettingOverridesResetDto,
  SettingOverridesUpdatedDto,
  UpdateSettingDto,
} from './dto/platform-settings.dto';

/** Quién administra la configuración (contrato O1 §9): el resto del personal solo la lee. */
const SETTINGS_ADMINS = ['SUPERADMIN', 'ADMIN'] as const;

const KEY_PARAM = {
  name: 'key',
  description: 'Clave del parámetro',
  example: 'trazabilidad.singani.reposoMinimoDias',
};

/**
 * Configuración en dos niveles desde el back office (contrato O1 §6; CFG-02,
 * CFG-03, CFG-04, CFG-07): estándar general, ajustes por bodega (a una
 * selección o a todas), "volver al estándar" e historial. Todo el personal de
 * plataforma lee; solo administración escribe, siempre con motivo.
 */
@ApiTags('Back office · Configuración')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Sin sesión' })
@ApiForbiddenResponse({
  description:
    'AUTH_INSUFFICIENT_PERMISSIONS: sin la organización de plataforma activa o rol sin permiso',
  type: ApiErrorResponseDto,
})
@Audience('STAFF')
@OrgType('PLATFORM')
@Roles('SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT')
@Controller('platform/settings')
export class PlatformSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Parámetros con su estándar general',
    description:
      'Todas las definiciones del catálogo con el estándar vigente, el número de bodegas con ajuste propio y el último cambio. No paginada: son menos de 50.',
  })
  @ApiOkResponse({ type: SettingDefinitionDto, isArray: true })
  list(): Promise<SettingDefinitionDto[]> {
    return this.settings.listDefinitions();
  }

  @Put(':key')
  @Roles(...SETTINGS_ADMINS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Cambiar el estándar general (ADMIN)',
    description:
      'Valida tipo, límites, niveles y el mínimo legal (el estándar nunca baja de él). Deja historial y bitácora (SETTING_CHANGED) con el antes, el después y el motivo, e invalida la caché.',
  })
  @ApiParam(KEY_PARAM)
  @ApiOkResponse({ type: SettingDefinitionDto })
  @ApiNotFoundResponse({
    description: 'SETTING_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'VALIDATION_ERROR (value, reason), SETTING_LEVEL_NOT_ALLOWED (parámetro solo por bodega) o SETTING_BELOW_LEGAL_MINIMUM',
    type: ApiErrorResponseDto,
  })
  async update(
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
  ): Promise<SettingDefinitionDto> {
    await this.settings.setGlobal(key, dto.value, { reason: dto.reason });
    return this.settings.definitionView(key);
  }

  @Get(':key/overrides')
  @ApiOperation({ summary: 'Ajustes por bodega de un parámetro' })
  @ApiParam(KEY_PARAM)
  @ApiPaginatedResponse(SettingOverrideDto, {
    description: 'Ajustes, del más reciente al más antiguo',
  })
  @ApiNotFoundResponse({
    description: 'SETTING_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  async overrides(
    @Param('key') key: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<SettingOverrideDto>> {
    const { items, total } = await this.settings.listOverrides(key, query);
    return toPage(items, total, query);
  }

  @Put(':key/overrides')
  @Roles(...SETTINGS_ADMINS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Aplicar un ajuste a una selección de bodegas o a todas (ADMIN)',
    description:
      "`wineryIds: 'ALL'` = todas las bodegas no revocadas. Un valor más laxo que el mínimo legal exige `legalException: true` (solo administración), que queda marcado en el ajuste, el historial y la bitácora (SETTING_OVERRIDE_SET, una entrada por bodega).",
  })
  @ApiParam(KEY_PARAM)
  @ApiOkResponse({ type: SettingOverridesUpdatedDto })
  @ApiNotFoundResponse({
    description: 'SETTING_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'VALIDATION_ERROR (value, reason, wineryIds: bodegas inexistentes), SETTING_LEVEL_NOT_ALLOWED (parámetro solo general) o SETTING_BELOW_LEGAL_MINIMUM',
    type: ApiErrorResponseDto,
  })
  setOverrides(
    @Param('key') key: string,
    @Body() dto: SetSettingOverridesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SettingOverridesUpdatedDto> {
    // La ruta ya es de administración; la comprobación queda explícita por si
    // otro rol llega a aplicar ajustes (A-31: la excepción es solo de ADMIN)
    if (
      dto.legalException &&
      !(SETTINGS_ADMINS as readonly string[]).includes(user.role ?? '')
    ) {
      throw new AppException(
        403,
        ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
        'Solo administración autoriza excepciones al mínimo legal',
      );
    }
    return this.settings.setOverrides(key, dto.wineryIds, dto.value, {
      reason: dto.reason,
      legalException: dto.legalException === true,
    });
  }

  @Post(':key/overrides/reset')
  @HttpCode(HttpStatus.OK)
  @Roles(...SETTINGS_ADMINS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Volver al estándar (ADMIN)',
    description:
      'Borra los ajustes de la selección (o de todas las bodegas con ALL). Una entrada SETTING_OVERRIDE_RESET por ajuste borrado.',
  })
  @ApiParam(KEY_PARAM)
  @ApiOkResponse({ type: SettingOverridesResetDto })
  @ApiNotFoundResponse({
    description: 'SETTING_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR (reason, wineryIds)',
    type: ApiErrorResponseDto,
  })
  reset(
    @Param('key') key: string,
    @Body() dto: ResetSettingOverridesDto,
  ): Promise<SettingOverridesResetDto> {
    return this.settings.resetOverrides(key, dto.wineryIds, {
      reason: dto.reason,
    });
  }

  @Get(':key/history')
  @ApiOperation({
    summary: 'Historial de cambios de un parámetro (CFG-07)',
    description:
      'Estándar y ajustes por bodega, del más reciente al más antiguo, con autor, motivo y valores antes y después.',
  })
  @ApiParam(KEY_PARAM)
  @ApiPaginatedResponse(SettingHistoryEntryDto, {
    description: 'Cambios, del más reciente al más antiguo',
  })
  @ApiNotFoundResponse({
    description: 'SETTING_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  async history(
    @Param('key') key: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<SettingHistoryEntryDto>> {
    const { items, total } = await this.settings.history(key, query);
    return toPage(items, total, query);
  }
}
