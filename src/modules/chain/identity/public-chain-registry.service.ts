import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import type { PublicChainRegistryDto } from '../dto/chain.dto';
import { explorerAccountUrl, explorerContractUrl } from '../explorer';

/** Versión de SEP-1 con la que se escribe el documento. */
const SEP1_VERSION = '2.7.0';
const ORG_NAME = 'Drinks on Chain';
const ORG_DESCRIPTION =
  'Trazabilidad y tokenización de bebidas de origen: cada bodega tiene su cuenta y su contrato NFT.';

/** Cadena TOML básica: comillas dobles con las barras y comillas escapadas. */
export function tomlString(value: string): string {
  const printable = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : character;
    })
    .join('');
  const escaped = printable.split('\\').join('\\\\').split('"').join('\\"');
  return `"${escaped}"`;
}

export interface StellarTomlInput {
  networkPassphrase: string;
  accounts: string[];
  orgUrl: string | null;
}

/**
 * `stellar.toml` (SEP-1; contrato O3 §3.2, S-7): `ACCOUNTS` y documentación.
 * Los contratos no van en `[[CURRENCIES]]`: no son activos SEP-41 y la fuente
 * canónica de "contratos oficiales" es `GET /v1/public/chain/registry`.
 */
export function buildStellarToml(input: StellarTomlInput): string {
  const accounts = [...new Set(input.accounts)];
  const lines = [
    `VERSION=${tomlString(SEP1_VERSION)}`,
    `NETWORK_PASSPHRASE=${tomlString(input.networkPassphrase)}`,
    accounts.length === 0
      ? 'ACCOUNTS=[]'
      : `ACCOUNTS=[\n${accounts.map((a) => `  ${tomlString(a)}`).join(',\n')}\n]`,
    '',
    '[DOCUMENTATION]',
    `ORG_NAME=${tomlString(ORG_NAME)}`,
    ...(input.orgUrl ? [`ORG_URL=${tomlString(input.orgUrl)}`] : []),
    `ORG_DESCRIPTION=${tomlString(ORG_DESCRIPTION)}`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Público · cuentas y contratos oficiales (contrato O3 §3.2; CHN-02). Lee
 * solo de la base: las direcciones de la plataforma las registra el worker y
 * las de cada bodega aparecen cuando su identidad queda `ACTIVE` (o
 * `PAUSED`). Sin datos personales.
 */
@Injectable()
export class PublicChainRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  private async platformAccounts(): Promise<{
    operations: string | null;
    anchor: string | null;
  }> {
    const rows = await this.prisma.chainAccount.findMany({
      where: {
        network: this.settings.network,
        role: { in: ['OPERATIONS', 'ANCHOR'] },
        wineryId: null,
      },
      select: { role: true, address: true },
    });
    const of = (role: string) =>
      rows.find((row) => row.role === role)?.address ?? null;
    return { operations: of('OPERATIONS'), anchor: of('ANCHOR') };
  }

  /** Contratos vigentes con la identidad de su bodega confirmada. */
  private officialContracts() {
    return this.prisma.nftContract.findMany({
      where: {
        network: this.settings.network,
        status: 'ACTIVE',
        address: { not: null },
        chainAccount: { status: { in: ['ACTIVE', 'PAUSED'] } },
      },
      include: {
        chainAccount: { select: { address: true } },
        winery: { select: { slug: true, commercialName: true } },
      },
      orderBy: { deployedAt: 'asc' },
    });
  }

  async registry(): Promise<PublicChainRegistryDto> {
    const explorer = this.settings.explorerBaseUrl;
    const [platform, contracts] = await Promise.all([
      this.platformAccounts(),
      this.officialContracts(),
    ]);
    return {
      network: this.settings.network,
      networkPassphrase: this.settings.networkPassphrase,
      wasmHash: this.settings.wasmHash,
      platform: {
        operationsAccount: platform.operations,
        anchorAccount: platform.anchor,
      },
      wineries: contracts.map((contract) => ({
        slug: contract.winery.slug ?? '',
        tradeName: contract.winery.commercialName,
        symbol: contract.symbol,
        account: contract.chainAccount.address ?? '',
        contract: contract.address ?? '',
        accountExplorerUrl: explorerAccountUrl(
          explorer,
          contract.chainAccount.address,
        ),
        contractExplorerUrl: explorerContractUrl(explorer, contract.address),
        paused: contract.paused,
        since: (contract.deployedAt ?? contract.createdAt).toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  async stellarToml(): Promise<string> {
    const [platform, contracts] = await Promise.all([
      this.platformAccounts(),
      this.officialContracts(),
    ]);
    const orgUrl = this.config.get<string>('APP_URL_MARKETPLACE')?.trim();
    return buildStellarToml({
      networkPassphrase: this.settings.networkPassphrase,
      accounts: [
        platform.operations,
        platform.anchor,
        ...contracts.map((contract) => contract.chainAccount.address),
      ].filter((address): address is string => !!address),
      orgUrl: orgUrl ? orgUrl.replace(/\/+$/, '') : null,
    });
  }
}
