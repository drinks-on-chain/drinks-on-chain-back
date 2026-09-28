import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { notImplemented } from '@modules/lots/domain/trace-errors';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiNotImplemented,
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

const CSV_HEADER =
  'serial,code,codeFormatted,qrUrl,lotCode,lotName,productType,bottlingDate';

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
  @Get('lots/:id/bottle-codes')
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Listar los códigos de botella del lote',
    description:
      'Contrato O2 §7.2: por número de serie, con filtros de estado y rango (`fromSerial`–`toSerial`). ' +
      'Rango inválido (`fromSerial > toSerial` o fuera de `1…N`) → 422 `VALIDATION_ERROR`.',
  })
  @ApiPaginatedResponse(BottleUnitDto, { description: 'Página de códigos' })
  @ApiLotNotFound()
  @ApiErrorCodes(HttpStatus.CONFLICT, ['TRC_LOT_NOT_BOTTLED'])
  @ApiNotImplemented('2.6')
  list(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
    @Query() _query: QueryBottleCodesDto,
  ): Paginated<BottleUnitDto> {
    throw notImplemented('2.6');
  }

  @Get('lots/:id/bottle-codes/export')
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Exportar los códigos de botella a CSV',
    description:
      `Contrato O2 §7.2: \`text/csv; charset=utf-8\` con la cabecera \`${CSV_HEADER}\`, ` +
      'opcionalmente por rango de serie. Queda en la bitácora (`BOTTLE_CODES_EXPORTED`) con el rango.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: `Archivo CSV (Content-Disposition: attachment). Cabecera: ${CSV_HEADER}`,
    content: {
      'text/csv': {
        schema: {
          type: 'string',
          example: `${CSV_HEADER}\n1,K7M2Q9XA,K7M2-Q9XA,https://app.drinksonchain.com/b/K7M2Q9XA,CVJ-2026-SINGANI-004,Singani Gran Reserva 2026,SINGANI,2026-10-01`,
        },
      },
    },
  })
  @ApiLotNotFound()
  @ApiErrorCodes(HttpStatus.CONFLICT, ['TRC_LOT_NOT_BOTTLED'])
  @ApiRuleErrors()
  @ApiNotImplemented('2.6')
  exportCsv(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
    @Query() _query: ExportBottleCodesCsvQueryDto,
  ): string {
    throw notImplemented('2.6');
  }

  @Post('lots/:id/bottle-codes/exports')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Solicitar la exportación ZIP para la imprenta',
    description:
      'Contrato O2 §7.2: ZIP con el CSV y una imagen de QR por botella (`{serial}-{code}.svg`), generado en el ' +
      'worker (`trace.bottle-codes.export`); caduca a los 7 días. Se consulta con `GET …/exports/{exportId}`.',
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    type: BottleCodeExportAcceptedDto,
  })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, ['TRC_LOT_NOT_BOTTLED'])
  @ApiRuleErrors()
  @ApiNotImplemented('2.6')
  createExport(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CreateBottleCodeExportDto,
  ): BottleCodeExportAcceptedDto {
    throw notImplemented('2.6');
  }

  @Get('lots/:id/bottle-codes/exports/:exportId')
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Estado de una exportación ZIP',
    description:
      'Contrato O2 §7.2: `downloadUrl` es una URL firmada de 15 min, solo con `status: READY`.',
  })
  @ApiOkResponse({ type: BottleCodeExportDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_LOT_NOT_FOUND', 'NOT_FOUND'])
  @ApiNotImplemented('2.6')
  getExport(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('exportId', ParseUUIDPipe) _exportId: string,
  ): BottleCodeExportDto {
    throw notImplemented('2.6');
  }

  @Post('bottle-codes/:code/void')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Anular un código de botella',
    description:
      'Contrato O2 §7.2: `replace: true` emite un código nuevo con la misma serie (etiqueta dañada). ' +
      'Con el expediente cerrado solo se anula sin sustituto (S-14). Queda en la bitácora (`BOTTLE_CODE_VOIDED`).',
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
  @ApiNotImplemented('2.6')
  voidCode(
    @TenantId() _wineryId: string,
    @Param('code') _code: string,
    @Body() _dto: VoidBottleCodeDto,
  ): BottleUnitDto {
    throw notImplemented('2.6');
  }
}
