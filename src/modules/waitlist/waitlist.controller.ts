import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import {
  Audience,
  OrgType,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { Public } from '@modules/auth/decorators/public.decorator';
import {
  AUTH_THROTTLER,
  authRouteLimit,
} from '@modules/auth/rate-limit/app-throttler.guard';
import { platformRolesWith } from '@modules/platform-users/permissions';
import {
  JoinWaitlistDto,
  UpdateWaitlistEntryDto,
  WaitlistEntryDto,
  WaitlistFiltersDto,
  WaitlistJoinResponseDto,
  WaitlistListQueryDto,
  WaitlistSourceDto,
  WaitlistSourcesQueryDto,
  WaitlistStatsDto,
} from './dto/waitlist.dto';
import { WAITLIST_DEFAULTS } from './waitlist.config';
import {
  WAITLIST_EXPORT_MAX_ROWS,
  waitlistCsvHeader,
  waitlistCsvRow,
  waitlistExportFilename,
} from './waitlist-csv';
import { WaitlistService } from './waitlist.service';

/** Lectura: administración, operaciones y soporte. */
const READERS = platformRolesWith('waitlist', 'FULL', 'READ');
/** Estado, notas y exportación: administración y operaciones. */
const WRITERS = platformRolesWith('waitlist', 'FULL');

const FORBIDDEN = {
  description:
    'AUTH_INSUFFICIENT_PERMISSIONS: sin la organización de plataforma activa o rol sin permiso',
  type: ApiErrorResponseDto,
};

/**
 * Inscripción pública en la lista de espera (contrato O1b §1): la landing
 * (`CONSUMER`) y el sitio de bodegas (`WINERY`), a través de su proxy
 * firmado, que deja en `request.ip` la IP real.
 */
@ApiTags('Público')
@Controller('public/waitlist')
export class PublicWaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({
    [AUTH_THROTTLER]: {
      limit: authRouteLimit(
        'WAITLIST_LIMIT_IP_MINUTE',
        WAITLIST_DEFAULTS.ipPerMinute,
      ),
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Inscribirse en la lista de espera',
    description:
      'Consumidores (`CONSUMER`, con `isAdult: true`) y bodegas (`WINERY`, con `wineryName`). Responde 201 con la posición dentro de su tipo (desde 1). Un correo ya inscrito en ese tipo recibe la misma respuesta con la posición que ya tenía (no se duplica; solo se completan `phone`, `city` y `region` si estaban vacíos). Campo trampa `website` relleno → 201 con una posición verosímil sin guardar nada. Límites: 20 por minuto y 300 por hora por IP real, 3 por hora por correo (`WAITLIST_LIMIT_IP_MINUTE`, `WAITLIST_LIMIT_IP_HOUR`, `WAITLIST_LIMIT_EMAIL_HOUR`) → 429 con `Retry-After`. El captcha solo se exige con `WAITLIST_CAPTCHA_REQUIRED=true`.',
  })
  @ApiCreatedResponse({ type: WaitlistJoinResponseDto })
  @ApiUnprocessableEntityResponse({
    description:
      'VALIDATION_ERROR (`details` por campo: `isAdult`, `consent`, `wineryName`, `email`…) o CAPTCHA_INVALID (en `captchaToken`)',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'TOO_MANY_REQUESTS (por IP o por correo), con Retry-After',
    type: ApiErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'CAPTCHA_UNAVAILABLE (solo con el captcha exigido)',
    type: ApiErrorResponseDto,
  })
  async join(
    @Body() dto: JoinWaitlistDto,
    @Req() req: Request,
  ): Promise<WaitlistJoinResponseDto> {
    const userAgent = req.headers['user-agent'];
    return this.waitlist.join(dto, {
      ip: req.ip ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
    });
  }

  @Public()
  @Get('stats')
  // Solo el límite global de peticiones (no el de las rutas de formularios)
  @SkipThrottle({ [AUTH_THROTTLER]: true })
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'Totales de la lista de espera',
    description:
      'Inscritos por tipo, para mostrar «ya somos N». Con caché de 60 s.',
  })
  @ApiOkResponse({ type: WaitlistStatsDto })
  async stats(): Promise<WaitlistStatsDto> {
    return this.waitlist.stats();
  }
}

/** Back office · lista de espera (contrato O1b §2). */
@ApiTags('Back office · lista de espera')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Sin sesión',
  type: ApiErrorResponseDto,
})
@ApiForbiddenResponse(FORBIDDEN)
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform/waitlist')
export class PlatformWaitlistController {
  private readonly logger = new Logger(PlatformWaitlistController.name);

  constructor(private readonly waitlist: WaitlistService) {}

  @Get()
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Lista de espera',
    description:
      'Más recientes primero. Filtros por tipo, estado, origen y fechas (AAAA-MM-DD = día completo UTC, o ISO); `q` busca en nombre, correo, bodega y teléfono.',
  })
  @ApiPaginatedResponse(WaitlistEntryDto)
  async list(
    @Query() query: WaitlistListQueryDto,
  ): Promise<Paginated<WaitlistEntryDto>> {
    return this.waitlist.list(query);
  }

  @Get('sources')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Orígenes de las inscripciones',
    description:
      'Cada origen (`source`; `null` = sin origen) con su número de inscritos, del más numeroso al menos. Para el filtro de la lista.',
  })
  @ApiOkResponse({ type: WaitlistSourceDto, isArray: true })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR en `type`',
    type: ApiErrorResponseDto,
  })
  async sources(
    @Query() query: WaitlistSourcesQueryDto,
  ): Promise<WaitlistSourceDto[]> {
    return this.waitlist.sources(query.type);
  }

  @Get('export')
  @Roles(...WRITERS)
  @ApiOperation({
    summary: 'Exportar la lista de espera a CSV',
    description: `Mismos filtros que la lista, en orden de llegada. Máximo ${WAITLIST_EXPORT_MAX_ROWS.toLocaleString('es')} filas (más → 422 WAITLIST_EXPORT_TOO_LARGE). UTF-8 con BOM, separador coma, CRLF; las celdas que empiezan como una fórmula (= + - @) llevan un apóstrofo delante. Sin IP ni agente de usuario. Se envía por partes (streaming) y queda en la bitácora (WAITLIST_EXPORTED, con el número de filas).`,
  })
  @ApiOkResponse({
    description: 'Archivo CSV (Content-Disposition: attachment)',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR en los filtros o WAITLIST_EXPORT_TOO_LARGE',
    type: ApiErrorResponseDto,
  })
  async export(
    @Query() query: WaitlistFiltersDto,
    @Res() res: Response,
  ): Promise<void> {
    const where = this.waitlist.where(query);
    const total = await this.waitlist.count(where);
    if (total > WAITLIST_EXPORT_MAX_ROWS) {
      throw new AppException(
        422,
        ErrorCode.WAITLIST_EXPORT_TOO_LARGE,
        `La exportación tiene ${total} filas y el máximo es ${WAITLIST_EXPORT_MAX_ROWS}: acota las fechas o los filtros`,
        [{ field: null, message: `${total} > ${WAITLIST_EXPORT_MAX_ROWS}` }],
      );
    }
    // Antes de enviar nada: sin entrada en la bitácora no hay exportación
    await this.waitlist.recordExport(total, query);

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${waitlistExportFilename()}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Rows', String(total));

    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const write = async (chunk: string) => {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
    };

    try {
      await write(waitlistCsvHeader());
      let written = 0;
      for await (const batch of this.waitlist.batches(where)) {
        if (closed) return;
        // Nunca más filas que las contadas (las inscripciones nuevas no entran)
        const rows = batch.slice(0, Math.max(0, total - written));
        if (rows.length === 0) break;
        await write(rows.map(waitlistCsvRow).join(''));
        written += rows.length;
        if (written >= total) break;
      }
      res.end();
    } catch (error) {
      this.logger.error({
        message: 'Exportación de la lista de espera interrumpida',
        error: error instanceof Error ? error.message : String(error),
      });
      res.destroy(error instanceof Error ? error : undefined);
    }
  }

  @Patch(':id')
  @Roles(...WRITERS)
  @ApiOperation({
    summary: 'Cambiar el estado o las notas de una inscripción',
    description:
      'Al pasar a `CONTACTED` se guardan `contactedAt` y quién lo marcó; al volver a `NEW` se borran. `notes: null` borra las notas. Queda en la bitácora (WAITLIST_STATUS_CHANGED). Sin cambios, devuelve la inscripción tal cual.',
  })
  @ApiOkResponse({ type: WaitlistEntryDto })
  @ApiNotFoundResponse({ description: 'NOT_FOUND', type: ApiErrorResponseDto })
  @ApiUnprocessableEntityResponse({
    description:
      'VALIDATION_ERROR (`status`, `notes` de más de 1000 caracteres)',
    type: ApiErrorResponseDto,
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWaitlistEntryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WaitlistEntryDto> {
    return this.waitlist.update(id, dto, user);
  }
}
