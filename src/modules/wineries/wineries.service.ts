import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { WineryRepository } from './repositories/winery.repository';
import { UpdateWineryDto } from './dto/update-winery.dto';
import { QueryWineriesDto } from './dto/query-wineries.dto';
import {
  WineryResponseDto,
  WineryMemberItemDto,
} from './dto/winery-response.dto';
import { Prisma, Winery, WineryMember, User } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { OrganizationsService } from '@modules/organizations/organizations.service';

type WineryWithMembers = Winery & {
  members?: (WineryMember & {
    user?: Pick<User, 'fullName' | 'email'> | null;
  })[];
  /** Cuenta real de la bodega en la red (contrato O3 §3), si ya existe. */
  chainAccount?: { address: string | null; status: string } | null;
};

/** Estados de la identidad con la cuenta confirmada en la red. */
const CONFIRMED_ACCOUNT_STATUSES = new Set(['ACTIVE', 'PAUSED']);

/**
 * Directorio de bodegas y perfil de la bodega activa (0.1). El alta, la
 * aprobación y el equipo viven en `winery-applications`, `winery-management`,
 * `invitations` y `team` desde la Ola 1 (las rutas antiguas se retiraron en H1).
 */
@Injectable()
export class WineriesService {
  private readonly logger = new Logger(WineriesService.name);

  constructor(
    private readonly wineryRepository: WineryRepository,
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
  ) {}

  /**
   * Obtiene la información institucional de la bodega asociada al tenant
   */
  async getMyWinery(wineryId: string): Promise<WineryResponseDto> {
    const winery = await this.wineryRepository.findById(wineryId);
    if (!winery) {
      throw new NotFoundException('Bodega no encontrada');
    }

    return this.mapToWineryResponse(winery);
  }

  /**
   * Actualiza datos comerciales y de contacto de la bodega
   */
  async updateMyWinery(
    wineryId: string,
    dto: UpdateWineryDto,
  ): Promise<WineryResponseDto> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const winery = await this.wineryRepository.update(
        wineryId,
        {
          commercialName: dto.commercialName?.trim(),
          address: dto.address?.trim(),
          contactEmail: dto.contactEmail?.toLowerCase().trim(),
          contactPhone: dto.contactPhone?.trim(),
          logoUrl: dto.logoUrl?.trim(),
        },
        tx,
      );
      await this.organizations.syncWinery(tx, winery);
      return winery;
    });

    this.logger.log(`Bodega actualizada: ${wineryId}`);
    return this.getMyWinery(updated.id);
  }

  /**
   * Lista todas las bodegas con soporte de filtros y paginación (Solo Platform Admin)
   */
  async findAllWineries(
    query: QueryWineriesDto,
  ): Promise<Paginated<WineryResponseDto>> {
    const where: Prisma.WineryWhereInput = {
      ...(query.status && { certificationStatus: query.status }),
      ...(query.beverageCategory && {
        beverageCategory: query.beverageCategory,
      }),
      ...(query.search && {
        OR: [
          { legalName: { contains: query.search, mode: 'insensitive' } },
          { commercialName: { contains: query.search, mode: 'insensitive' } },
          { taxIdNit: { contains: query.search } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.winery.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: { createdAt: 'desc' },
        include: {
          chainAccount: { select: { address: true, status: true } },
          members: {
            include: { user: true },
          },
        },
      }),
      this.prisma.winery.count({ where }),
    ]);

    return toPage(
      items.map((w) => this.mapToWineryResponse(w)),
      total,
      query,
    );
  }

  private mapToWineryResponse(winery: WineryWithMembers): WineryResponseDto {
    const members: WineryMemberItemDto[] | undefined = winery.members?.map(
      (m) => ({
        id: m.id,
        userId: m.userId,
        fullName: m.user?.fullName ?? '',
        email: m.user?.email ?? '',
        memberRole: m.memberRole,
        professionalLicenseNumber: m.professionalLicenseNumber,
        isActive: m.isActive,
        joinedAt: m.joinedAt,
      }),
    );

    return {
      id: winery.id,
      legalName: winery.legalName,
      commercialName: winery.commercialName,
      beverageCategory: winery.beverageCategory,
      taxIdNit: winery.taxIdNit,
      senasagSanitaryReg: winery.senasagSanitaryReg,
      geographicRegion: winery.geographicRegion,
      countryCode: winery.countryCode,
      address: winery.address,
      contactEmail: winery.contactEmail,
      contactPhone: winery.contactPhone,
      logoUrl: winery.logoUrl,
      // Compatibilidad hasta H3 (contrato O3 §3.3.5, SE-02): la cuenta
      // **real** de la bodega o `null`; nunca las direcciones simuladas de
      // antes (guardadas en `legacy_simulated_*`). Sin ProducerRegistry (C7)
      // no hay identificador de productor; el hash de la creación de la
      // cuenta llega con la identidad (paso 3.2)
      stellarPublicKey:
        winery.chainAccount &&
        CONFIRMED_ACCOUNT_STATUSES.has(winery.chainAccount.status)
          ? winery.chainAccount.address
          : null,
      onchainProducerId: null,
      onchainRegisterTxHash: null,
      isExportCertified: winery.isExportCertified,
      certificationStatus: winery.certificationStatus,
      approvedAt: winery.approvedAt,
      createdAt: winery.createdAt,
      members,
    };
  }
}
