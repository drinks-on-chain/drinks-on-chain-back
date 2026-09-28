import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
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
import { notImplemented } from '@modules/lots/domain/trace-errors';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiErrorCodes, ApiNotImplemented } from './contract-responses';
import {
  ProductionReportDto,
  ProductionReportQueryDto,
  TraceDashboardDto,
} from './dto/traceability-insights.dto';

const REPORT_CSV_HEADER =
  'lotId,reference,lotCode,name,productType,harvestYear,stage,netKg,mustLiters,baseWineLiters,heartLiters,' +
  'bottledLiters,bottles,formatCl,lossPercentFermentation,lossPercentTransfer,lossPercentDistillation,' +
  'lossPercentBottling,litersPerKg,bottlesPerTonne,bottlingDate,labStatus';

/** Panel y reportes de la trazabilidad de la bodega (contrato O2 §11.2 y §11.4). */
@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('traceability')
export class TraceabilityInsightsController {
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
  @ApiNotImplemented('2.9')
  dashboard(@TenantId() _wineryId: string | undefined): TraceDashboardDto {
    throw notImplemented('2.9');
  }

  @Get('reports/production')
  @Roles('OWNER', 'ENOLOGIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Reporte de producción',
    description:
      'Contrato O2 §11.4: una fila por lote con la conciliación kilos → litros → botellas y las mermas por ' +
      'etapa, más totales por tipo de producto (`WINE`, `SINGANI` y `UNDECIDED` para los lotes aún sin tipo). ' +
      '`format=csv` devuelve `text/csv; charset=utf-8` con las mismas columnas (sin totales). Máximo 10 000 ' +
      'filas; más → 422 `TRC_REPORT_TOO_LARGE`.',
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
  @ApiNotImplemented('2.9')
  productionReport(
    @TenantId() _wineryId: string | undefined,
    @Query() _query: ProductionReportQueryDto,
  ): ProductionReportDto {
    throw notImplemented('2.9');
  }
}
