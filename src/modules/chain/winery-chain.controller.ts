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
import { TenantId } from '@shared/decorators/tenant-id.decorator';
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
  ApiNotImplementedO3,
  ApiRoleForbidden,
  ApiRuleErrors,
  WINERY_MEMBERS,
  notImplementedO3,
} from './contract/o3-contract';
import {
  ChainActionDto,
  WineryChainAccountViewDto,
  WineryChainIdentityDto,
} from './dto/chain.dto';

const READERS = platformRolesWith('chain', 'FULL', 'READ');
/** Reaprovisionar la identidad: administración y operaciones. */
const OPERATORS = platformRolesWith('chain', 'FULL');
/** Pausar o reanudar el contrato en la red: administración. */
const ADMINS = platformRolesWith('chain.admin', 'FULL');

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
  @Get(':id/chain-account')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Cuenta de una bodega en la red',
    description:
      'Contrato O3 §3.4: identidad (cuenta y contrato), NFT por lote, anclajes, últimas transacciones y lo ' +
      'pagado por la plataforma por esa bodega.',
  })
  @ApiOkResponse({ type: WineryChainAccountViewDto })
  @ApiRoleForbidden()
  @WINERY_NOT_FOUND()
  @ApiNotImplementedO3('3.6')
  chainAccount(
    @Param('id', ParseUUIDPipe) _id: string,
  ): Promise<WineryChainAccountViewDto> {
    throw notImplementedO3('3.6');
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
  ])
  @ApiRuleErrors(['(falta `reason`)'])
  @ApiNotImplementedO3('3.2')
  provision(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: ChainActionDto,
  ): Promise<WineryChainIdentityDto> {
    throw notImplementedO3('3.2');
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
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', '(falta `reason`)'])
  @ApiNotImplementedO3('3.2')
  pause(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: ChainActionDto,
  ): Promise<WineryChainIdentityDto> {
    throw notImplementedO3('3.2');
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
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', '(falta `reason`)'])
  @ApiNotImplementedO3('3.2')
  unpause(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: ChainActionDto,
  ): Promise<WineryChainIdentityDto> {
    throw notImplementedO3('3.2');
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
  @ApiNotImplementedO3('3.6')
  chainAccount(
    @TenantId() _wineryId: string | undefined,
  ): Promise<WineryChainAccountViewDto> {
    throw notImplementedO3('3.6');
  }
}
