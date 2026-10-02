import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { BottleCodesService } from '@modules/lots/bottle-codes.service';
import {
  BOTTLE_CSV_HEADER,
  bottleCsvHeader,
  bottleCsvRow,
} from '@modules/lots/domain/bottle-csv';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiPlatformReadOnly,
  ApiRuleErrors,
} from './contract-responses';
import {
  BottleCodeExportAcceptedDto,
  BottleCodeExportDto,
  BottleUnitDto,
  CreateBottleCodeExportDto,
  ExportBottleCodesCsvQueryDto,
  QueryBottleCodesDto,
  VoidBottleCodeDto,
} from './dto/bottle-codes.dto';

/** Personal de plataforma que puede listar los códigos (contrato O2 §14). */
const PLATFORM_CODE_READERS = ['SUPERADMIN', 'ADMIN', 'OPERATIONS'];

function forbidden(message: string): AppException {
  return new AppException(
    403,
    ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
    message,
  );
}

/**
 * Códigos de botella (contrato O2 §7.2). Listar, exportar y anular: OWNER y
 * ENOLOGIST; la plataforma solo lista (ADMIN, OPERATIONS). Los demás roles
 * ven solo los totales del embotellado (§6.3).
 */
@ApiTags('Códigos de botella')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller()
export class BottleCodesController {
  private readonly logger = new Logger(BottleCodesController.name);

  constructor(private readonly codes: BottleCodesService) {}

  @Get('lots/:id/bottle-codes')
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Listar y buscar los códigos de botella del lote',
    description:
      'Contrato O2 §7.2: por número de serie, con filtros de estado y rango (`fromSerial`–`toSerial`) y ' +
      'búsqueda `q` por fragmento del código o por número de serie. Un código sustituido y su sustituto ' +
      'comparten serie (primero el anulado). Rango inválido (`fromSerial > toSerial` o fuera de `1…N`) → 422 ' +
      '`VALIDATION_ERROR`. De la plataforma solo listan ADMIN y OPERATIONS (con `?wineryId=`).',
  })
  @ApiPaginatedResponse(BottleUnitDto, { description: 'Página de códigos' })
  @ApiLotNotFound()
  @ApiErrorCodes(HttpStatus.FORBIDDEN, [
    'AUTH_INSUFFICIENT_PERMISSIONS (otros roles: solo los totales del embotellado)',
  ])
  @ApiErrorCodes(HttpStatus.CONFLICT, ['TRC_LOT_NOT_BOTTLED'])
  list(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryBottleCodesDto,
  ) {
    if (
      user.organizationType === 'PLATFORM' &&
      !PLATFORM_CODE_READERS.includes(user.role ?? '')
    ) {
      throw forbidden(
        'Los códigos de botella solo los lista el personal de administración y de operaciones',
      );
    }
    return this.codes.list(wineryId, id, query);
  }

  @Get('lots/:id/bottle-codes/export')
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Exportar los códigos de botella a CSV',
    description:
      `Contrato O2 §7.2: \`text/csv; charset=utf-8\` con la cabecera \`${BOTTLE_CSV_HEADER}\`, ` +
      'una fila por código **activo**, opcionalmente por rango de serie. UTF-8 con BOM, separador coma, CRLF. ' +
      'Se envía por partes (streaming); la cabecera `X-Export-Rows` lleva el número de filas. Queda registrada ' +
      'en `bottle_code_exports` y en la bitácora (`BOTTLE_CODES_EXPORTED`) con el rango. Solo la bodega ' +
      '(la plataforma no exporta códigos: 403).',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: `Archivo CSV (Content-Disposition: attachment). Cabecera: ${BOTTLE_CSV_HEADER}`,
    content: {
      'text/csv': {
        schema: {
          type: 'string',
          example: `${BOTTLE_CSV_HEADER}\n1,K7M2Q9XA,K7M2-Q9XA,https://app.drinksonchain.com/b/K7M2Q9XA,CVJ-2026-SINGANI-004,Singani Gran Reserva 2026,SINGANI,2026-10-01`,
        },
      },
    },
  })
  @ApiLotNotFound()
  @ApiErrorCodes(HttpStatus.FORBIDDEN, [
    'AUTH_INSUFFICIENT_PERMISSIONS (rol sin permiso o personal de plataforma)',
  ])
  @ApiErrorCodes(HttpStatus.CONFLICT, ['TRC_LOT_NOT_BOTTLED'])
  @ApiRuleErrors()
  async exportCsv(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExportBottleCodesCsvQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    if (user.organizationType === 'PLATFORM' || !wineryId) {
      throw forbidden('Solo la bodega exporta sus códigos de botella');
    }
    // Antes de enviar nada: sin su entrada en la bitácora no hay exportación
    const exported = await this.codes.prepareCsvExport(
      wineryId,
      id,
      user.id,
      query,
    );

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exported.filename}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Rows', String(exported.rows));
    res.setHeader('X-Export-Id', exported.exportId);

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
      await write(bottleCsvHeader());
      for await (const batch of this.codes.csvBatches(
        exported.lotId,
        exported.range,
      )) {
        if (closed) return;
        await write(
          batch.map((unit) => bottleCsvRow(unit, exported.context)).join(''),
        );
      }
      res.end();
    } catch (error) {
      this.logger.error({
        message: 'Exportación de códigos de botella interrumpida',
        exportId: exported.exportId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.destroy(error instanceof Error ? error : undefined);
    }
  }

  @Post('lots/:id/bottle-codes/exports')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Solicitar la exportación ZIP para la imprenta',
    description:
      'Contrato O2 §7.2: ZIP con `codigos.csv` y una imagen de QR por código activo del rango ' +
      '(`qr/{serial}-{code}.svg` o `.png`; por defecto 512 px y 4 módulos de margen), generado en el worker ' +
      '(`trace.bottle-codes.export`); caduca a los 7 días. Como máximo 20 000 códigos por exportación (más → ' +
      '422: se exporta por rangos). Se consulta con `GET …/exports/{exportId}`. Queda en la bitácora ' +
      '(`BOTTLE_CODES_EXPORTED`) con el rango.',
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    type: BottleCodeExportAcceptedDto,
  })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, ['TRC_LOT_NOT_BOTTLED'])
  @ApiRuleErrors()
  createExport(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBottleCodeExportDto,
  ): Promise<BottleCodeExportAcceptedDto> {
    return this.codes.requestZipExport(wineryId, id, user.id, dto);
  }

  @Get('lots/:id/bottle-codes/exports/:exportId')
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Estado de una exportación',
    description:
      'Contrato O2 §7.2: `downloadUrl` es una URL firmada de 15 min, solo con el ZIP `READY` y sin caducar. ' +
      'Solo la bodega (la plataforma no exporta códigos: 403).',
  })
  @ApiOkResponse({ type: BottleCodeExportDto })
  @ApiErrorCodes(HttpStatus.FORBIDDEN, [
    'AUTH_INSUFFICIENT_PERMISSIONS (rol sin permiso o personal de plataforma)',
  ])
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_LOT_NOT_FOUND', 'NOT_FOUND'])
  getExport(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BottleCodeExportDto> {
    if (user.organizationType === 'PLATFORM' || !wineryId) {
      throw forbidden('Solo la bodega exporta sus códigos de botella');
    }
    return this.codes.getExport(wineryId, id, exportId);
  }

  @Post('bottle-codes/:code/void')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Anular un código de botella',
    description:
      'Contrato O2 §7.2: `replace: true` emite un código nuevo con la misma serie (etiqueta dañada); la ' +
      'respuesta es el código anulado, con el sustituto en `voided.replacedBy`. Con el expediente cerrado solo ' +
      'se anula sin sustituto (S-14). Queda en la línea de tiempo del lote y en la bitácora ' +
      '(`BOTTLE_CODE_VOIDED`).',
  })
  @ApiParam({
    name: 'code',
    description:
      'Código de 8 caracteres (se normaliza: mayúsculas, sin espacios ni guiones, O → 0, I/L → 1)',
    example: 'K7M2Q9XA',
  })
  @ApiOkResponse({ type: BottleUnitDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_BOTTLE_CODE_NOT_FOUND'])
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_BOTTLE_CODE_ALREADY_VOIDED',
    'TRC_DOSSIER_CLOSED (con `replace: true`)',
  ])
  @ApiRuleErrors()
  voidCode(
    @TenantId() wineryId: string,
    @Param('code') code: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VoidBottleCodeDto,
  ): Promise<BottleUnitDto> {
    return this.codes.voidCode(wineryId, code, user.id, dto);
  }
}
