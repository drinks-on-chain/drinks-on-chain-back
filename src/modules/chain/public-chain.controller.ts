import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '@modules/auth/decorators/public.decorator';
import { PublicChainRegistryDto } from './dto/chain.dto';
import { PublicChainRegistryService } from './identity/public-chain-registry.service';

const PUBLIC_NOTE =
  'Sin sesión. Mismo límite por IP real que el pasaporte (O2 §12.4) y respuesta cacheable.';

/** Caché de 5 min (§3.2). */
const CACHE_5_MIN = 'public, max-age=300';

/**
 * Público · registro de cuentas y contratos oficiales (contrato O3 §3.2;
 * CHN-02). Sin datos personales. La verificación del anclaje (§7.3) vive con
 * el pasaporte del lote (`lots/contract/public-verification.controller.ts`).
 */
@ApiTags('Public')
@Controller('public')
export class PublicChainController {
  constructor(private readonly registryService: PublicChainRegistryService) {}

  @Public()
  @Get('chain/registry')
  @Header('Cache-Control', CACHE_5_MIN)
  @ApiOperation({
    summary: 'Registro público de cuentas y contratos oficiales',
    description:
      'Contrato O3 §3.2: fuente canónica (JSON) de "contratos oficiales": red, código, cuentas de operaciones ' +
      'y de anclaje, y la cuenta y el contrato de cada bodega con identidad `ACTIVE` (o `PAUSED`, con ' +
      `\`paused: true\`). Con la cadena sin configurar, las cuentas son \`null\` y la lista, vacía. ${PUBLIC_NOTE}`,
  })
  @ApiOkResponse({ type: PublicChainRegistryDto })
  registry(): Promise<PublicChainRegistryDto> {
    return this.registryService.registry();
  }
}

/**
 * `stellar.toml` (SEP-1), fuera de `/v1`: lo sirve el backend en el dominio
 * `STELLAR_HOME_DOMAIN`.
 */
@ApiTags('Public')
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class StellarTomlController {
  constructor(private readonly registryService: PublicChainRegistryService) {}

  @Public()
  @Get('stellar.toml')
  @ApiOperation({
    summary: 'stellar.toml (SEP-1)',
    description:
      'Contrato O3 §3.2: `text/plain` con `Access-Control-Allow-Origin: *` y caché de 5 min. Contenido: ' +
      '`VERSION`, `NETWORK_PASSPHRASE`, `ACCOUNTS` (operaciones, anclaje y la cuenta de cada bodega `ACTIVE`) y ' +
      '`[DOCUMENTATION]` (`ORG_NAME = "Drinks on Chain"`). Los contratos se publican en ' +
      '`GET /v1/public/chain/registry` (fuente canónica), no en `[[CURRENCIES]]` (S-7). Los errores llegan con ' +
      'el envoltorio JSON común.',
  })
  @ApiProduces('text/plain')
  @ApiOkResponse({
    description: 'Documento TOML',
    content: {
      'text/plain': {
        schema: { type: 'string' },
        example:
          'VERSION="2.7.0"\nNETWORK_PASSPHRASE="Test SDF Network ; September 2015"\nACCOUNTS=[]\n\n[DOCUMENTATION]\nORG_NAME="Drinks on Chain"\n',
      },
    },
  })
  async stellarToml(@Res() res: Response): Promise<void> {
    const toml = await this.registryService.stellarToml();
    // Texto tal cual, sin el envoltorio JSON; SEP-1 exige CORS abierto
    res
      .status(HttpStatus.OK)
      .set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': CACHE_5_MIN,
      })
      .send(toml);
  }
}
