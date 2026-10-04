import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { BottlingBatchResponseDto } from '@modules/traceability/dto/bottling-batch-response.dto';
import { BottlingService } from '@modules/traceability/services/bottling.service';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { LotBottlingService } from '../lot-bottling.service';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiPlatformReadOnly,
  ApiRuleErrors,
} from './contract-responses';
import {
  BottlingPreviewDto,
  CreateLotBottlingDto,
} from './dto/lot-bottling.dto';

/** Códigos de regla del embotellado (§6.2). */
const BOTTLING_RULE_CODES = [
  'TRC_LOCK_NOT_RELEASED',
  'TRC_BOTTLING_SOURCE_INVALID',
  'TRC_BOTTLING_SOURCES_PENDING',
  'TRC_BOTTLING_EXCEEDS_VOLUME',
  'TRC_BOTTLING_LOSS_ABOVE_TOLERANCE',
  'TRC_ALCOHOL_BALANCE_EXCEEDED',
  'TRC_DILUTION_NOT_ALLOWED',
  'TRC_COMPLIANCE_ISSUES_OPEN',
  'TRC_DATE_IN_FUTURE',
  'TRC_DATE_BEFORE_PREVIOUS_STAGE',
  'TRC_FILE_NOT_FOUND',
] as const;

/** Embotellado seguro del lote (contrato O2 §6). */
@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('lots')
export class LotBottlingController {
  constructor(
    private readonly lotBottling: LotBottlingService,
    private readonly bottling: BottlingService,
  ) {}

  @Post(':id/bottling/preview')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Vista previa del embotellado',
    description:
      'Contrato O2 §6.1: evalúa el cuerpo con las reglas de §6.2 sin escribir nada y devuelve el balance ' +
      'y una violación por regla incumplida, para que la UI lo explique antes de confirmar.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: BottlingPreviewDto })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_LOT_ALREADY_BOTTLED',
    'TRC_LOT_TERMINAL',
  ])
  @ApiRuleErrors()
  preview(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateLotBottlingDto,
  ): Promise<BottlingPreviewDto> {
    return this.lotBottling.preview(wineryId, id, dto);
  }

  @Post(':id/bottling')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Embotellar el lote',
    description:
      'Contrato O2 §6.1–§6.3: una sola vez por lote (S-10). Tipo derivado de las fuentes, candados con la ' +
      'instantánea y el reloj de la base, balance de volumen y de alcohol, sin agua en vino. En la misma ' +
      'transacción las fuentes pasan a `BOTTLED`, el lote a `BOTTLED`, se asigna `lotCode` y se generan los ' +
      'códigos de botella (§7).',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: BottlingBatchResponseDto })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_LOT_ALREADY_BOTTLED',
    'TRC_LOT_TERMINAL',
    'TRC_INVALID_STAGE',
  ])
  @ApiRuleErrors(BOTTLING_RULE_CODES)
  async create(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLotBottlingDto,
  ) {
    const bottlingId = await this.lotBottling.create(
      wineryId,
      id,
      user.id,
      dto,
    );
    return this.bottling.findById(wineryId, bottlingId);
  }
}
