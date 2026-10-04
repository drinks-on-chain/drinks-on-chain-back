import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { LotViewsService } from '../views/lot-views.service';
import { ApiLotNotFound } from './contract-responses';
import {
  LotBalanceDto,
  LotGraphDto,
  LotTimelineDto,
} from './dto/lot-views.dto';

/** Vistas del lote (contrato O2 §11.1 y §11.3). Lectura: miembros y plataforma. */
@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('lots')
export class LotViewsController {
  constructor(private readonly views: LotViewsService) {}

  @Get(':id/timeline')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Línea de tiempo del lote',
    description:
      'Contrato O2 §11.1: eventos del lote en orden (`seq`), candados y fecha estimada de disponibilidad. ' +
      'Las lecturas diarias se agrupan en un evento `FERMENTATION_READINGS` por tanque y día; ' +
      '`visibility: PUBLIC` es lo que ve el pasaporte. Plataforma con `?wineryId=`.',
  })
  @ApiOkResponse({ type: LotTimelineDto })
  @ApiLotNotFound()
  timeline(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LotTimelineDto> {
    return this.views.timeline(wineryId, id);
  }

  @Get(':id/balance')
  // OPERATOR solo tiene la lectura mínima (lista, ficha, línea de tiempo; §14)
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Balance kilos → litros → botellas',
    description:
      'Contrato O2 §11.3: conciliación con mermas por etapa (`aging` solo en vino, `distillation` solo en singani), ' +
      'balance del embotellado y proyección de botellas (S-19): vino = litros de la última etapa × (1 − merma máxima) ÷ formato; ' +
      'singani = corazón × grado ÷ `targetAbvPercent` × (1 − merma máxima) ÷ formato; sin datos, la estimación declarada. ' +
      'Las mermas sin los dos volúmenes registrados llegan en `null` (no se suponen en cero); `litersPerKg` usa los kilos que entraron a tanques.',
  })
  @ApiOkResponse({ type: LotBalanceDto })
  @ApiLotNotFound()
  balance(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LotBalanceDto> {
    return this.views.balance(wineryId, id);
  }

  /**
   * SE-07 exige **404** (no el 403 de `@OrgType`) a cualquier sesión que no
   * sea de la bodega dueña ni del personal de plataforma: aquí se anulan el
   * tipo de organización y los roles de la clase y el permiso lo comprueba el
   * servicio.
   */
  @Get(':id/graph')
  @OrgType()
  @Roles()
  @ApiOperation({
    summary: 'Grafo de trazabilidad del lote',
    description:
      'Contrato O2 §11.3: nodos (parcelas, pesajes, tanques, crianzas, destilaciones, embotellado, laboratorio) ' +
      'con cantidades y métricas reales (`null` = no registrado) y aristas con lo transferido. ' +
      'SE-07: solo miembros de la bodega dueña y personal de plataforma; cualquier otra sesión → 404.',
  })
  @ApiOkResponse({ type: LotGraphDto })
  @ApiLotNotFound()
  graph(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LotGraphDto> {
    return this.views.graphForUser(user, id);
  }
}
