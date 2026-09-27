import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { WineryRepository } from './repositories/winery.repository';
import { WineryMemberRepository } from './repositories/winery-member.repository';
import { WalletsService } from '@modules/wallets/wallets.service';
import { OnchainProducerHook } from './hooks/onchain-producer.hook';
import * as bcrypt from 'bcrypt';
import { CreateWineryDto } from './dto/create-winery.dto';
import { UpdateWineryDto } from './dto/update-winery.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { CreateMemberDto } from './dto/create-member.dto';
import { ApproveWineryDto } from './dto/approve-winery.dto';
import { RejectWineryDto } from './dto/reject-winery.dto';
import { QueryWineriesDto } from './dto/query-wineries.dto';
import {
  WineryResponseDto,
  WineryMemberItemDto,
} from './dto/winery-response.dto';
import {
  WineryStatusEnum,
  WineryMemberRoleEnum,
  WalletPurposeEnum,
  UserRoleEnum,
  Prisma,
  Winery,
  WineryMember,
  User,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';

type WineryWithMembers = Winery & {
  members?: (WineryMember & {
    user?: Pick<User, 'fullName' | 'email'> | null;
  })[];
};

@Injectable()
export class WineriesService {
  private readonly logger = new Logger(WineriesService.name);

  constructor(
    private readonly wineryRepository: WineryRepository,
    private readonly wineryMemberRepository: WineryMemberRepository,
    private readonly walletsService: WalletsService,
    private readonly onchainProducerHook: OnchainProducerHook,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Solicitud de onboarding de una nueva bodega (Estado inicial: PENDING)
   */
  async createWinery(
    userId: string,
    dto: CreateWineryDto,
  ): Promise<WineryResponseDto> {
    const existingTax = await this.wineryRepository.findByTaxId(dto.taxIdNit);
    if (existingTax) {
      throw new ConflictException(
        'El Número de Identificación Tributaria (NIT) ya se encuentra registrado',
      );
    }

    // 1. Crear bodega en estado PENDING
    const winery = await this.wineryRepository.create({
      legalName: dto.legalName.trim(),
      commercialName: dto.commercialName.trim(),
      beverageCategory: dto.beverageCategory,
      taxIdNit: dto.taxIdNit.trim(),
      senasagSanitaryReg: dto.senasagSanitaryReg?.trim() ?? null,
      geographicRegion: dto.geographicRegion.trim(),
      countryCode: dto.countryCode?.trim() ?? 'BO',
      address: dto.address?.trim() ?? null,
      contactEmail: dto.contactEmail.toLowerCase().trim(),
      contactPhone: dto.contactPhone?.trim() ?? null,
      logoUrl: dto.logoUrl?.trim() ?? null,
      certificationStatus: WineryStatusEnum.PENDING,
    });

    // 2. Vincular al usuario creador como OWNER / WINERY_ADMIN
    await this.wineryMemberRepository.create({
      userId,
      wineryId: winery.id,
      memberRole: WineryMemberRoleEnum.OWNER,
    });

    // 3. Aprovisionar billetera custodial institucional para la bodega
    const wineryWallet = await this.walletsService.provisionWineryWallet(
      userId,
      winery.id,
      WalletPurposeEnum.PRODUCER_SIGNING,
    );

    // 4. Actualizar las claves públicas y vault de la bodega
    const updatedWinery = await this.wineryRepository.update(winery.id, {
      stellarPublicKey: wineryWallet.stellarPublicAddress,
      dynamicVaultId: wineryWallet.dynamicVaultId,
    });

    this.logger.log(
      `Bodega creada en estado PENDING: ${updatedWinery.id} ("${updatedWinery.commercialName}") con Stellar Key: ${wineryWallet.stellarPublicAddress}`,
    );

    return this.mapToWineryResponse(updatedWinery);
  }

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
    const updated = await this.wineryRepository.update(wineryId, {
      commercialName: dto.commercialName?.trim(),
      address: dto.address?.trim(),
      contactEmail: dto.contactEmail?.toLowerCase().trim(),
      contactPhone: dto.contactPhone?.trim(),
      logoUrl: dto.logoUrl?.trim(),
    });

    this.logger.log(`Bodega actualizada: ${wineryId}`);
    return this.getMyWinery(updated.id);
  }

  /**
   * Incorpora un nuevo miembro operativo a la bodega
   */
  async addMember(
    wineryId: string,
    dto: AddMemberDto,
  ): Promise<WineryMemberItemDto> {
    // Validar existencia del usuario
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true, fullName: true, email: true },
    });

    if (!user) {
      throw new NotFoundException('El usuario especificado no existe');
    }

    // Validar si ya es miembro
    const existingMembership = await this.wineryMemberRepository.findMembership(
      dto.userId,
      wineryId,
    );
    if (existingMembership) {
      throw new ConflictException(
        'El usuario ya se encuentra registrado como miembro de esta bodega',
      );
    }

    const member = await this.wineryMemberRepository.create({
      userId: dto.userId,
      wineryId,
      memberRole: dto.memberRole,
      professionalLicenseNumber: dto.professionalLicenseNumber?.trim(),
      professionalLicensePdfUrl: dto.professionalLicensePdfUrl?.trim(),
    });

    // Sincronizar userRole con el rol operativo asignado
    const roleMapping: Partial<Record<WineryMemberRoleEnum, UserRoleEnum>> = {
      [WineryMemberRoleEnum.ENOLOGIST]: UserRoleEnum.ENOLOGIST,
      [WineryMemberRoleEnum.AGRONOMIST]: UserRoleEnum.AGRONOMIST,
      [WineryMemberRoleEnum.OPERATOR]: UserRoleEnum.POS_OPERATOR,
      [WineryMemberRoleEnum.OWNER]: UserRoleEnum.WINERY_ADMIN,
    };
    const targetUserRole = roleMapping[dto.memberRole];
    if (targetUserRole) {
      await this.prisma.user.update({
        where: { id: dto.userId },
        data: { userRole: targetUserRole },
      });
    }

    this.logger.log(
      `Nuevo miembro añadido a bodega ${wineryId}: ${user.fullName} (${dto.memberRole})`,
    );

    return {
      id: member.id,
      userId: user.id,
      fullName: user.fullName,
      email: user.email,
      memberRole: member.memberRole,
      professionalLicenseNumber: member.professionalLicenseNumber,
      isActive: member.isActive,
      joinedAt: member.joinedAt,
    };
  }

  /**
   * Crea un nuevo usuario y lo incorpora directamente como miembro operativo de la bodega
   */
  async createAndAddMember(
    wineryId: string,
    dto: CreateMemberDto,
  ): Promise<WineryMemberItemDto> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });

    if (existingUser) {
      throw new ConflictException(
        'El correo electrónico ya se encuentra registrado. Utilice la opción de incorporar usuario existente.',
      );
    }

    const roleMapping: Partial<Record<WineryMemberRoleEnum, UserRoleEnum>> = {
      [WineryMemberRoleEnum.ENOLOGIST]: UserRoleEnum.ENOLOGIST,
      [WineryMemberRoleEnum.AGRONOMIST]: UserRoleEnum.AGRONOMIST,
      [WineryMemberRoleEnum.OPERATOR]: UserRoleEnum.POS_OPERATOR,
      [WineryMemberRoleEnum.OWNER]: UserRoleEnum.WINERY_ADMIN,
    };
    const userRole = roleMapping[dto.memberRole] ?? UserRoleEnum.CONSUMER;

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase().trim(),
        passwordHash,
        fullName: dto.fullName.trim(),
        userRole,
        phoneNumber: dto.phoneNumber?.trim() ?? null,
        preferredLocale: 'es',
        isActive: true,
      },
    });

    // Aprovisionar billetera custodial para el nuevo miembro
    await this.walletsService.provisionUserWallet(
      user.id,
      WalletPurposeEnum.CONSUMER_NFT,
    );

    const member = await this.wineryMemberRepository.create({
      userId: user.id,
      wineryId,
      memberRole: dto.memberRole,
      professionalLicenseNumber: dto.professionalLicenseNumber?.trim(),
      professionalLicensePdfUrl: dto.professionalLicensePdfUrl?.trim(),
    });

    this.logger.log(
      `Nuevo miembro creado y añadido a bodega ${wineryId}: ${user.fullName} (${dto.memberRole})`,
    );

    return {
      id: member.id,
      userId: user.id,
      fullName: user.fullName,
      email: user.email,
      memberRole: member.memberRole,
      professionalLicenseNumber: member.professionalLicenseNumber,
      isActive: member.isActive,
      joinedAt: member.joinedAt,
    };
  }

  /**
   * Lista todos los miembros operativos de la bodega
   */
  async getMyMembers(wineryId: string): Promise<WineryMemberItemDto[]> {
    const members =
      await this.wineryMemberRepository.findMembersByWineryId(wineryId);

    return members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      fullName: m.user.fullName,
      email: m.user.email,
      memberRole: m.memberRole,
      professionalLicenseNumber: m.professionalLicenseNumber,
      isActive: m.isActive,
      joinedAt: m.joinedAt,
    }));
  }

  /**
   * Lista todas las bodegas pendientes de aprobación (Solo Platform Admin)
   */
  async getPendingWineries(): Promise<WineryResponseDto[]> {
    const wineries = await this.wineryRepository.findPendingWineries();
    return wineries.map((w) => this.mapToWineryResponse(w));
  }

  /**
   * Aprobación institucional de una bodega y ejecución del hook C-01 ProducerRegistry
   */
  async approveWinery(
    wineryId: string,
    adminUserId: string,
    _dto?: ApproveWineryDto,
  ): Promise<WineryResponseDto> {
    const winery = await this.wineryRepository.findById(wineryId);
    if (!winery) {
      throw new NotFoundException('Bodega no encontrada');
    }

    if (winery.certificationStatus !== WineryStatusEnum.PENDING) {
      throw new BadRequestException(
        `La bodega se encuentra en estado '${winery.certificationStatus}' y no puede ser aprobada nuevamente`,
      );
    }

    // Ejecución del hook de registro on-chain (desacoplado en Etapa 1)
    const stellarKey =
      winery.stellarPublicKey ||
      'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q';
    const onchainResult =
      await this.onchainProducerHook.executeProducerRegistration(
        winery,
        stellarKey,
      );

    // Actualización de estado en base de datos
    const approvedWinery = await this.wineryRepository.update(wineryId, {
      certificationStatus: WineryStatusEnum.ACTIVE,
      approvedAt: new Date(),
      approvedByUser: { connect: { id: adminUserId } },
      onchainProducerId: onchainResult.onchainProducerId,
      onchainRegisterTxHash: onchainResult.txHash,
    });

    this.logger.log(
      `Bodega ${wineryId} APROBADA exitosamente por admin ${adminUserId}. Onchain ID: ${onchainResult.onchainProducerId}`,
    );

    return this.mapToWineryResponse(approvedWinery);
  }

  /**
   * Rechazo institucional de una solicitud de bodega (Solo Platform Admin)
   */
  async rejectWinery(
    wineryId: string,
    adminUserId: string,
    dto: RejectWineryDto,
  ): Promise<WineryResponseDto> {
    const winery = await this.wineryRepository.findById(wineryId);
    if (!winery) {
      throw new NotFoundException('Bodega no encontrada');
    }

    if (winery.certificationStatus !== WineryStatusEnum.PENDING) {
      throw new BadRequestException(
        `La bodega se encuentra en estado '${winery.certificationStatus}' y no puede ser rechazada`,
      );
    }

    const rejectedWinery = await this.wineryRepository.update(wineryId, {
      certificationStatus: WineryStatusEnum.REVOKED,
      approvedAt: new Date(),
      approvedByUser: { connect: { id: adminUserId } },
    });

    this.logger.log(
      `Bodega ${wineryId} RECHAZADA por admin ${adminUserId}. Motivo: ${dto.rejectionReason}`,
    );

    return this.mapToWineryResponse(rejectedWinery);
  }

  /**
   * Lista todas las bodegas con soporte de filtros y paginación (Solo Platform Admin)
   */
  async findAllWineries(
    query: QueryWineriesDto,
  ): Promise<{ items: WineryResponseDto[]; total: number }> {
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
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
        orderBy: { createdAt: 'desc' },
        include: {
          wallets: true,
          members: {
            include: { user: true },
          },
        },
      }),
      this.prisma.winery.count({ where }),
    ]);

    return {
      items: items.map((w) => this.mapToWineryResponse(w)),
      total,
    };
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
      stellarPublicKey: winery.stellarPublicKey,
      onchainProducerId: winery.onchainProducerId,
      onchainRegisterTxHash: winery.onchainRegisterTxHash,
      isExportCertified: winery.isExportCertified,
      certificationStatus: winery.certificationStatus,
      approvedAt: winery.approvedAt,
      createdAt: winery.createdAt,
      members,
    };
  }
}
