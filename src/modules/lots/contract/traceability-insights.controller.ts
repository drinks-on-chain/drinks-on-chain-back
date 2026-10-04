import { Controller, Get, HttpStatus, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import type { Request, Response } from 'express';
import { laPazDate } from '@modules/lots/domain/dates';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import {
  PRODUCTION_REPORT_COLUMNS,
  productionReportCsv,
  TraceInsightsService,
} from '../views/trace-insights.service';
import { ApiErrorCodes } from './contract-responses';
import {
  ProductionReportDto,
  ProductionReportQueryDto,
  TraceDashboardDto,
} from './dto/traceability-insights.dto';

const REPORT_CSV_HEADER = PRODUCTION_REPORT_COLUMNS.join(',');

/** Panel y reportes de la trazabilidad de la bodega (contrato O2 §11.2 y §11.4). */
@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('traceability')
export class TraceabilityInsightsController {
  constructor(private readonly insights: TraceInsightsService) {}

  @Get('dashboard')
  // OPERATOR solo tiene la lectura mínima (lista, ficha, línea de tiempo; §14)
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Panel de la trazabilidad de la bodega',
    description:
      'Contrato O2 §11.2: lotes por etapa, candados que se liberan en ≤ 14 días, alertas de fermentación ' +
      '(> 32 °C en la última lectura o 48 h sin lecturas en un tanque `FERMENTING`, S-18), dictámenes ' +
      'pendientes, lotes embotellados sin laboratorio, lotes listos para cerrar, incidencias abiertas y uva ' +
      'sin lote. Plataforma con `?wineryId=`.',
  })
  @ApiQuery({
    name: 'wineryId',
    required: false,
    schema: { type: 'string', format: 'uuid' },
    description: 'Solo personal de plataforma: bodega sobre la que se consulta',
  })
  @ApiOkResponse({ type: TraceDashboardDto })
  dashboard(
    @TenantId() wineryId: string | undefined,
  ): Promise<TraceDashboardDto> {
    return this.insights.dashboard(wineryId) as Promise<TraceDashboardDto>;
  }

  @Get('reports/production')
  @Roles('OWNER', 'ENOLOGIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Reporte de producción',
    description:
      'Contrato O2 §11.4: una fila por lote con la conciliación kilos → litros → botellas y las mermas por ' +
      'etapa, más totales por tipo de producto (`WINE`, `SINGANI` y `UNDECIDED` para los lotes aún sin tipo). ' +
      '`from`/`to` filtran por la fecha de creación del lote (America/La_Paz, inclusive). `format=csv` devuelve ' +
      '`text/csv; charset=utf-8` (UTF-8 con BOM, coma, CRLF) con las mismas columnas (sin totales). Máximo ' +
      '10 000 filas; más → 422 `TRC_REPORT_TOO_LARGE`. `bottles` son las botellas embotelladas; ' +
      '`litersPerKg` de cada fila usa los kilos que entraron a tanques.',
  })
  @ApiExtraModels(ProductionReportDto)
  @ApiProduces('application/json', 'text/csv')
  @ApiOkResponse({
    description: `JSON (\`format=json\`) o CSV (\`format=csv\`, cabecera: ${REPORT_CSV_HEADER})`,
    content: {
      'application/json': {
        schema: { $ref: getSchemaPath(ProductionReportDto) },
      },
      'text/csv': { schema: { type: 'string', example: REPORT_CSV_HEADER } },
    },
  })
  @ApiErrorCodes(HttpStatus.UNPROCESSABLE_ENTITY, [
    'VALIDATION_ERROR',
    'TRC_REPORT_TOO_LARGE',
  ])
  async productionReport(
    @TenantId() wineryId: string | undefined,
    @Query() query: ProductionReportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.insights.productionReport(wineryId, query);
    res.status(HttpStatus.OK);
    res.setHeader('Cache-Control', 'no-store');
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="reporte-produccion-${laPazDate(new Date())}.csv"`,
      );
      res.setHeader('X-Export-Rows', String(report.rows.length));
      res.send(productionReportCsv(report.rows));
      return;
    }
    // Con `@Res()` la respuesta no pasa por el interceptor: mismo envoltorio
    res.json({
      success: true,
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      path: req.url,
      data: report satisfies ProductionReportDto,
    });
  }
}
