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
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { LotAttachmentsService } from '../views/lot-attachments.service';
import {
  ApiErrorCodes,
  ApiLotNotFound,
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
  constructor(private readonly attachments: LotAttachmentsService) {}

  @Post(':id/attachments')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  // AGRONOMIST y OPERATOR adjuntan a sus propios registros (§14)
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR')
  @ApiOperation({
    summary: 'Adjuntar un archivo al lote',
    description:
      'Contrato O2 §11.5: referencia un archivo ya subido con `POST /v1/uploads` por su `key`. Por defecto ' +
      '`PRIVATE`; la etiqueta (`LABEL`) nace `PUBLIC` (S-20). Queda en la línea de tiempo (`FILE_ATTACHED`). ' +
      'Pedir `PUBLIC` para otro tipo de archivo exige ser OWNER o ENOLOGIST (403).',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: LotAttachmentDto })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_LOT_TERMINAL',
    'TRC_DOSSIER_CLOSED',
  ])
  @ApiRuleErrors(['TRC_FILE_NOT_FOUND'])
  create(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLotAttachmentDto,
  ): Promise<LotAttachmentDto> {
    return this.attachments.create(wineryId, id, user, dto);
  }

  @Get(':id/attachments')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Archivos del lote',
    description:
      'Contrato O2 §11.5: incluye los informes de dictamen y laboratorio adjuntados en §3.4 y §8, cada uno con ' +
      'una URL firmada de 15 min, los más recientes primero. AGRONOMIST y OPERATOR solo ven los que adjuntaron ' +
      '(§14). Plataforma con `?wineryId=`.',
  })
  @ApiPaginatedResponse(LotAttachmentDto, {
    description: 'Página de archivos del lote',
  })
  @ApiLotNotFound()
  list(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WineryScopedPaginationQueryDto,
  ): Promise<Paginated<LotAttachmentDto>> {
    return this.attachments.list(wineryId, id, user, query);
  }

  @Post(':id/attachments/:attachmentId/visibility')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Cambiar la visibilidad de un archivo del lote',
    description:
      'Contrato O2 §11.5: solo inserción (el cambio se registra en la línea de tiempo y la bitácora; no se edita ' +
      'el adjunto). `PUBLIC` lo muestra el pasaporte en `publicAttachments`. Solo los archivos adjuntados al lote ' +
      '(los informes de dictamen y laboratorio son siempre privados).',
  })
  @ApiOkResponse({ type: LotAttachmentDto })
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_LOT_NOT_FOUND', 'NOT_FOUND'])
  @ApiPlatformReadOnly()
  @ApiRuleErrors()
  changeVisibility(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangeLotAttachmentVisibilityDto,
  ): Promise<LotAttachmentDto> {
    return this.attachments.changeVisibility(
      wineryId,
      id,
      attachmentId,
      user,
      dto.visibility,
    );
  }
}
