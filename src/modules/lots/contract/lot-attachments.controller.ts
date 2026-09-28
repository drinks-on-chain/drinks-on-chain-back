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
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
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
  ChangeLotAttachmentVisibilityDto,
  CreateLotAttachmentDto,
  LotAttachmentDto,
} from './dto/lot-attachments.dto';

/** Archivos privados del lote (contrato O2 §11.5). */
@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('lots')
export class LotAttachmentsController {
  @Post(':id/attachments')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  // AGRONOMIST y OPERATOR adjuntan a sus propios registros (§14)
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR')
  @ApiOperation({
    summary: 'Adjuntar un archivo al lote',
    description:
      'Contrato O2 §11.5: referencia un archivo ya subido con `POST /v1/uploads` por su `key`. Por defecto ' +
      '`PRIVATE`; la etiqueta (`LABEL`) nace `PUBLIC` (S-20). Queda en la línea de tiempo (`FILE_ATTACHED`).',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: LotAttachmentDto })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_LOT_TERMINAL',
    'TRC_DOSSIER_CLOSED',
  ])
  @ApiRuleErrors(['TRC_FILE_NOT_FOUND'])
  @ApiNotImplemented('2.9')
  create(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CreateLotAttachmentDto,
  ): LotAttachmentDto {
    throw notImplemented('2.9');
  }

  @Get(':id/attachments')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Archivos del lote',
    description:
      'Contrato O2 §11.5: incluye los informes de dictamen y laboratorio adjuntados en §3.4 y §8, cada uno con ' +
      'una URL firmada de 15 min. Plataforma con `?wineryId=`.',
  })
  @ApiPaginatedResponse(LotAttachmentDto, {
    description: 'Página de archivos del lote',
  })
  @ApiLotNotFound()
  @ApiNotImplemented('2.9')
  list(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
    @Query() _query: WineryScopedPaginationQueryDto,
  ): Paginated<LotAttachmentDto> {
    throw notImplemented('2.9');
  }

  @Post(':id/attachments/:attachmentId/visibility')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Cambiar la visibilidad de un archivo del lote',
    description:
      'Contrato O2 §11.5: solo inserción (el cambio se registra, no se edita el adjunto). `PUBLIC` lo muestra ' +
      'el pasaporte en `publicAttachments`.',
  })
  @ApiOkResponse({ type: LotAttachmentDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_LOT_NOT_FOUND', 'NOT_FOUND'])
  @ApiPlatformReadOnly()
  @ApiRuleErrors()
  @ApiNotImplemented('2.9')
  changeVisibility(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('attachmentId', ParseUUIDPipe) _attachmentId: string,
    @Body() _dto: ChangeLotAttachmentVisibilityDto,
  ): LotAttachmentDto {
    throw notImplemented('2.9');
  }
}
