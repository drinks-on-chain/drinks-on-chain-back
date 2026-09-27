import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  Audience,
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { toPage } from '@shared/dto/pagination-query.dto';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { AuditQueryService } from './audit-query.service';
import { OrganizationAuditQueryDto } from './dto/audit-query.dto';
import { AuditEventDto } from './dto/audit-event.dto';

/**
 * Bitácora de la bodega activa para su dueño (contrato O1 §7, AUD-04): lo que
 * afecta a su bodega —también lo que hizo en ella el back office— y lo que
 * hicieron sus miembros desde ella. Se puede leer con la bodega suspendida
 * (contrato O1 §4). El personal de plataforma la consulta con `?wineryId=`.
 */
@ApiTags('Bitácora')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Sin sesión' })
@ApiForbiddenResponse({
  description:
    'AUTH_INSUFFICIENT_PERMISSIONS (sin bodega activa o sin ser su dueño) u ORG_NOT_ACTIVE',
  type: ApiErrorResponseDto,
})
@ApiNotFoundResponse({
  description: 'NOT_FOUND: wineryId de otra bodega (dueño) · ORG_NOT_FOUND',
  type: ApiErrorResponseDto,
})
@Audience('STAFF')
@OrgType('WINERY')
@Roles('OWNER')
@Controller('organizations/current/audit')
export class OrganizationAuditController {
  constructor(private readonly auditQuery: AuditQueryService) {}

  @Get()
  @RequireActiveOrg({ allow: ['SUSPENDED'] })
  @ApiOperation({
    summary: 'Bitácora de mi bodega (dueño)',
    description:
      'Mismos filtros que la del back office salvo la organización, de la más reciente a la más antigua (seq descendente).',
  })
  @ApiPaginatedResponse(AuditEventDto, {
    description: 'Entradas, de la más reciente a la más antigua',
  })
  async list(
    @Query() query: OrganizationAuditQueryDto,
    @TenantId() wineryId: string | undefined,
  ): Promise<Paginated<AuditEventDto>> {
    if (!wineryId) {
      // Personal de plataforma sin ?wineryId=: la de todas está en /platform/audit
      throw ValidationException.forField(
        'wineryId',
        'Indica la bodega (?wineryId=) o usa /v1/platform/audit',
      );
    }
    const { wineryId: _ignored, limit, offset, ...filters } = query;
    const { items, total } = await this.auditQuery.list(
      this.auditQuery.organizationWhere(wineryId, filters),
      { limit, offset },
    );
    return toPage(items, total, query);
  }
}
