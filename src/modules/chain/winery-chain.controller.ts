import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequiresReason } from '@shared/audit/requires-reason';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  Audience,
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { platformRolesWith } from '@modules/platform-users/permissions';
import {
  ApiErrorCodes,
  ApiRoleForbidden,
  ApiRuleErrors,
  WINERY_MEMBERS,
} from './contract/o3-contract';
import {
  ChainActionDto,
  WineryChainAccountViewDto,
  WineryChainIdentityDto,
} from './dto/chain.dto';
import { WineryChainActionsService } from './identity/winery-chain-actions.service';

const READERS = platformRolesWith('chain', 'FULL', 'READ');
/** Reaprovisionar la identidad: administración y operaciones. */
const OPERATORS = platformRolesWith('chain', 'FULL');
/** Pausar o reanudar el contrato en la red: administración. */
const ADMINS = platformRolesWith('chain.admin', 'FULL');

/** La cadena no está configurada en este entorno (sin custodio o sin RPC). */
const CHAIN_DISABLED = 'CHN_DISABLED (cadena sin configurar)';

const WINERY_NOT_FOUND = () =>
  ApiErrorCodes(HttpStatus.NOT_FOUND, ['ORG_NOT_FOUND']);

/**
 * Back office · identidad de una bodega en la red (contrato O3 §3.1, §3.4 y
 * §3.5; CHN-01, CHN-02, ORG-06). La pausa **en la red** detiene emisión,
 * entregas y quemas de toda la bodega; la pausa comercial de una colección
 * (§6.4) nunca toca la red.
 */
@ApiTags('Chain')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform/wineries')
export class PlatformWineryChainController {
  constructor(private readonly actions: WineryChainActionsService) {}

  @Get(':id/chain-account')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Cuenta de una bodega en la red',
    description:
      'Contrato O3 §3.4: identidad (cuenta y contrato), NFT por lote, anclajes, últimas transacciones y lo ' +
      'pagado por la plataforma por esa bodega. Las colecciones (`totals`, `byLot`) llegan con los pasos 3.4–3.6.',
  })
  @ApiOkResponse({ type: WineryChainAccountViewDto })
  @ApiRoleForbidden()
  @WINERY_NOT_FOUND()
  chainAccount(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WineryChainAccountViewDto> {
    return this.actions.accountView(id);
  }

  @Post(':id/chain/provision')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(...OPERATORS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Relanzar el aprovisionamiento de la identidad',
    description:
      'Contrato O3 §3.1: para una identidad `FAILED` o `NOT_PROVISIONED`. Encola `CREATE_WINERY_ACCOUNT` y ' +
      '`DEPLOY_WINERY_CONTRACT` (idempotente por `intentKey`: repetirla no crea otra cuenta ni otro contrato).',
  })
  @ApiAcceptedResponse({ type: WineryChainIdentityDto })
  @ApiRoleForbidden()
  @WINERY_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'CHN_IDENTITY_ALREADY_ACTIVE',
    'TOK_WINERY_NOT_ACTIVE (`meta.status`)',
    CHAIN_DISABLED,
  ])
  @ApiRuleErrors(['(falta `reason`)'])
  provision(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChainActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryChainIdentityDto> {
    return this.actions.provision(id, dto.reason, user);
  }

  @Post(':id/chain/pause')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(...ADMINS)
  @Idempotent({ required: true })
  @RequiresReason()
  @ApiOperation({
    summary: 'Pausar el contrato de la bodega en la red',
    description:
      'Contrato O3 §3.5 (incidente: clave comprometida, fallo del contrato): encola `PAUSE_CONTRACT`, firmado ' +
      'por el operador. La identidad pasa a `PAUSED`. `Idempotency-Key` obligatoria.',
  })
  @ApiAcceptedResponse({ type: WineryChainIdentityDto })
  @ApiRoleForbidden()
  @WINERY_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'CHN_CONTRACT_ALREADY_PAUSED',
    'TOK_WINERY_CHAIN_NOT_READY (sin contrato; `meta.status`)',
    CHAIN_DISABLED,
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', '(falta `reason`)'])
  pause(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChainActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryChainIdentityDto> {
    return this.actions.pause(id, dto.reason, user);
  }

  @Post(':id/chain/unpause')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(...ADMINS)
  @Idempotent({ required: true })
  @RequiresReason()
  @ApiOperation({
    summary: 'Reanudar el contrato de la bodega en la red',
    description:
      'Contrato O3 §3.5: encola `UNPAUSE_CONTRACT`, firmado con la clave custodiada de la bodega (solo la ' +
      'bodega, como administradora, reanuda). `Idempotency-Key` obligatoria.',
  })
  @ApiAcceptedResponse({ type: WineryChainIdentityDto })
  @ApiRoleForbidden()
  @WINERY_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'CHN_CONTRACT_NOT_PAUSED',
    CHAIN_DISABLED,
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', '(falta `reason`)'])
  unpause(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChainActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryChainIdentityDto> {
    return this.actions.unpause(id, dto.reason, user);
  }
}

/**
 * ERP · cuenta de la bodega (contrato O3 §3.4; ORG-12, pantalla 1F). Solo
 * lectura: el ERP no guarda ni ve claves, y no firma nada.
 */
@ApiTags('Chain')
@ApiBearerAuth()
@OrgType('WINERY')
@Controller('organizations/current')
export class CurrentOrganizationChainController {
  constructor(private readonly actions: WineryChainActionsService) {}

  @Get('chain-account')
  @Roles(...WINERY_MEMBERS)
  @RequireActiveOrg({ allow: ['SUSPENDED'] })
  @ApiOperation({
    summary: 'Cuenta de la bodega en la red',
    description:
      'Contrato O3 §3.4: estado de la identidad (`PROVISIONING` = "Preparando tu cuenta en la red"), dirección ' +
      'de la cuenta y del contrato con enlaces al explorador, símbolo, NFT emitidos, vendidos y quemados por ' +
      'lote, anclajes y últimas transacciones. Legible también con la bodega suspendida.',
  })
  @ApiQuery({
    name: 'wineryId',
    required: false,
    schema: { type: 'string', format: 'uuid' },
    description: 'Solo personal de plataforma: la bodega que se consulta',
  })
  @ApiOkResponse({ type: WineryChainAccountViewDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['ORG_NOT_FOUND'])
  @ApiRuleErrors(['(personal de plataforma sin `wineryId`)'])
  chainAccount(
    @TenantId() wineryId: string | undefined,
  ): Promise<WineryChainAccountViewDto> {
    if (!wineryId) {
      throw new AppException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.VALIDATION_ERROR,
        'Indica la bodega que se consulta',
        [{ field: 'wineryId', message: 'wineryId es obligatorio' }],
      );
    }
    return this.actions.accountView(wineryId);
  }
}
