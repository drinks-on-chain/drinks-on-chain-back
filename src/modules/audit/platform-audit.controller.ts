import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  Audience,
  OrgType,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { toPage } from '@shared/dto/pagination-query.dto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { AuditQueryService } from './audit-query.service';
import {
  AUDIT_EXPORT_MAX_ROWS,
  auditCsvHeader,
  auditCsvRow,
  auditExportFilename,
} from './audit-csv';
import {
  AuditFiltersDto,
  AuditListQueryDto,
  AuditRangeQueryDto,
} from './dto/audit-query.dto';
import { AuditEventDto, AuditVerifyResultDto } from './dto/audit-event.dto';

/**
 * Bitácora desde el back office (contrato O1 §7, AUD-03): consulta con
 * filtros, exportación CSV y verificación de la cadena. Lectura para
 * administración, operaciones y soporte; verificar, solo administración.
 */
@ApiTags('Back office · Bitácora')
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
@Controller('platform/audit')
export class PlatformAuditController {
  private readonly logger = new Logger(PlatformAuditController.name);

  constructor(private readonly auditQuery: AuditQueryService) {}

  @Get()
  @ApiOperation({
    summary: 'Consultar la bitácora',
    description:
      'Entradas con filtros por fecha (AAAA-MM-DD = día completo UTC, o ISO), persona, organización afectada, acción y recurso, de la más reciente a la más antigua (seq descendente).',
  })
  @ApiPaginatedResponse(AuditEventDto, {
    description: 'Entradas, de la más reciente a la más antigua',
  })
  async list(
    @Query() query: AuditListQueryDto,
  ): Promise<Paginated<AuditEventDto>> {
    const { items, total } = await this.auditQuery.list(
      this.auditQuery.where(query),
      query,
    );
    return toPage(items, total, query);
  }

  @Get('export')
  @ApiOperation({
    summary: 'Exportar la bitácora a CSV',
    description: `Mismos filtros que la consulta, en orden cronológico. Máximo ${AUDIT_EXPORT_MAX_ROWS.toLocaleString('es')} filas (más → 422 AUDIT_EXPORT_TOO_LARGE). UTF-8 con BOM, separador coma, CRLF; las celdas que empiezan como una fórmula (= + - @) llevan un apóstrofo delante. Se envía por partes (streaming).`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Archivo CSV (Content-Disposition: attachment)',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR en los filtros o AUDIT_EXPORT_TOO_LARGE',
    type: ApiErrorResponseDto,
  })
  async export(
    @Query() query: AuditFiltersDto,
    @Res() res: Response,
  ): Promise<void> {
    const where = this.auditQuery.where(query);
    const total = await this.auditQuery.count(where);
    if (total > AUDIT_EXPORT_MAX_ROWS) {
      throw new AppException(
        422,
        ErrorCode.AUDIT_EXPORT_TOO_LARGE,
        `La exportación tiene ${total} filas y el máximo es ${AUDIT_EXPORT_MAX_ROWS}: acota las fechas o los filtros`,
        [{ field: null, message: `${total} > ${AUDIT_EXPORT_MAX_ROWS}` }],
      );
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${auditExportFilename()}"`,
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
      await write(auditCsvHeader());
      let written = 0;
      for await (const batch of this.auditQuery.batches(where)) {
        if (closed) return;
        // Nunca más filas que las contadas (las entradas nuevas no entran)
        const rows = batch.slice(0, Math.max(0, total - written));
        if (rows.length === 0) break;
        await write(rows.map(auditCsvRow).join(''));
        written += rows.length;
        if (written >= total) break;
      }
      res.end();
    } catch (error) {
      this.logger.error({
        message: 'Exportación de la bitácora interrumpida',
        error: error instanceof Error ? error.message : String(error),
      });
      res.destroy(error instanceof Error ? error : undefined);
    }
  }

  @Get('verify')
  @Roles('SUPERADMIN', 'ADMIN')
  @ApiOperation({
    summary: 'Verificar la cadena de la bitácora (ADMIN)',
    description:
      'Recalcula el hash de cada entrada del tramo (fechas incluidas; sin ellas, toda la bitácora) y su enlace con la anterior. firstBrokenSeq = primera entrada manipulada, borrada o intercalada.',
  })
  @ApiOkResponse({ type: AuditVerifyResultDto })
  verify(@Query() query: AuditRangeQueryDto): Promise<AuditVerifyResultDto> {
    return this.auditQuery.verify(query);
  }
}
