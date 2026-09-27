import {
  Injectable,
  ConflictException,
  NotFoundException,
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
  Prisma,
  Winery,
  WineryMember,
  User,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  PaginationQueryDto,
  toPage,
  toPrismaPage,
} from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { ConflictException as AppConflictException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { OutboxService } from '@shared/outbox/outbox.service';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { OrganizationsService } from '@modules/organizations/organizations.service';
import { MembershipsService } from '@modules/organizations/memberships.service';
import { legacyUserRoleForNewMember } from '@modules/organizations/organization.constants';
import {
  RevocationReason,
  SessionsService,
} from '@modules/auth/sessions/sessions.service';
import { ensureLotPrefix, freeSlug } from './winery-codes';
import {
  MEMBER_ADDED,
  MemberAddedPayload,
  WINERY_AGGREGATE,
  WINERY_CREATED,
  WineryCreatedPayload,
} from './wineries.events';

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
    private readonly outbox: OutboxService,
    private readonly organizations: OrganizationsService,
    private readonly memberships: MembershipsService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Solicitud de onboarding de una nueva bodega (Estado inicial: INVITED).
   *
   * Bodega, su organización (mismo id), membresía de dueño, billetera, claves
   * de la bodega y el evento
   * `winery.created` del outbox se escriben en una sola transacción (OP-01):
   * si un paso falla no queda nada a medias. La activación de la bóveda en el
   * proveedor la hace el worker a partir del evento.
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

    const { updatedWinery, wineryWallet } = await this.prisma.$transaction(
      async (tx) => {
        // 1. Crear bodega en estado INVITED
        const winery = await this.wineryRepository.create(
          {
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
            certificationStatus: WineryStatusEnum.INVITED,
            slug: await freeSlug(tx, dto.commercialName.trim()),
          },
          tx,
        );
        await tx.wineryStatusChange.create({
          data: {
            wineryId: winery.id,
            status: WineryStatusEnum.INVITED,
            byUserId: userId,
            byName: await this.userName(tx, userId),
          },
        });

        // 2. Organización de la bodega (mismo id) y membresía OWNER del creador
        await this.organizations.createForWinery(tx, winery);
        await this.memberships.addToWinery(tx, {
          wineryId: winery.id,
          userId,
          role: WineryMemberRoleEnum.OWNER,
        });

        // 3. Aprovisionar billetera custodial institucional para la bodega
        const wallet = await this.walletsService.provisionWineryWallet(
          userId,
          winery.id,
          WalletPurposeEnum.PRODUCER_SIGNING,
          tx,
        );

        // 4. Actualizar las claves públicas y vault de la bodega
        const updated = await this.wineryRepository.update(
          winery.id,
          {
            stellarPublicKey: wallet.stellarPublicAddress,
            dynamicVaultId: wallet.dynamicVaultId,
          },
          tx,
        );

        // 5. Efectos externos por el outbox (los procesa el worker)
        await this.outbox.add<WineryCreatedPayload>(tx, {
          type: WINERY_CREATED,
          aggregateType: WINERY_AGGREGATE,
          aggregateId: winery.id,
          queue: QUEUE_CHAIN,
          payload: {
            wineryId: winery.id,
            ownerUserId: userId,
            walletId: wallet.id,
            vaultId: wallet.dynamicVaultId,
            stellarPublicKey: wallet.stellarPublicAddress,
          },
        });

        // 6. Bitácora (último paso: toma el candado de la cadena)
        await this.audit.record(tx, {
          action: AuditAction.WINERY_CREATED,
          resource: { type: 'winery', id: winery.id },
          organizationId: winery.id,
          after: updated,
        });

        return { updatedWinery: updated, wineryWallet: wallet };
      },
    );

    this.logger.log(
      `Bodega creada en estado INVITED: ${updatedWinery.id} ("${updatedWinery.commercialName}") con Stellar Key: ${wineryWallet.stellarPublicAddress}`,
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
   * Incorpora a una persona existente a la bodega, o reactiva su membresía
   * (SE-01): solo escribe la membresía de **esta** bodega. No toca el rol
   * global ni membresías de otras organizaciones (plataforma incluida).
   */
  async addMember(
    wineryId: string,
    dto: AddMemberDto,
  ): Promise<WineryMemberItemDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true, fullName: true, email: true },
    });
    if (!user) {
      throw new NotFoundException('El usuario especificado no existe');
    }

    const member = await this.prisma.$transaction((tx) =>
      this.memberships.addToWinery(tx, {
        wineryId,
        userId: dto.userId,
        role: dto.memberRole,
        professionalLicenseNumber: dto.professionalLicenseNumber?.trim(),
        professionalLicensePdfUrl: dto.professionalLicensePdfUrl?.trim(),
      }),
    );

    this.logger.log(
      `Miembro ${user.id} incorporado a la bodega ${wineryId} (${dto.memberRole})`,
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
   * Crea un nuevo usuario y lo incorpora directamente como miembro operativo de la bodega.
   *
   * Usuario, billetera, membresía y el evento `member.added` del outbox van en
   * una sola transacción (OP-01). La activación de la bóveda la hace el worker.
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

    // Cuenta nueva: `user_role` (obsoleto) solo informativo; el operario de
    // planta ya no es POS_OPERATOR (OP-05)
    const userRole = legacyUserRoleForNewMember(dto.memberRole);

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const { user, member } = await this.prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
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
      const wallet = await this.walletsService.provisionUserWallet(
        createdUser.id,
        WalletPurposeEnum.CONSUMER_NFT,
        tx,
      );

      const createdMember = await this.memberships.addToWinery(tx, {
        wineryId,
        userId: createdUser.id,
        role: dto.memberRole,
        professionalLicenseNumber: dto.professionalLicenseNumber?.trim(),
        professionalLicensePdfUrl: dto.professionalLicensePdfUrl?.trim(),
      });

      await this.outbox.add<MemberAddedPayload>(tx, {
        type: MEMBER_ADDED,
        aggregateType: WINERY_AGGREGATE,
        aggregateId: wineryId,
        queue: QUEUE_CHAIN,
        payload: {
          wineryId,
          userId: createdUser.id,
          memberId: createdMember.id,
          memberRole: createdMember.memberRole,
          walletId: wallet.id,
          vaultId: wallet.dynamicVaultId,
        },
      });

      return { user: createdUser, member: createdMember };
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
  async getMyMembers(
    wineryId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<WineryMemberItemDto>> {
    const [members, total] =
      await this.wineryMemberRepository.findMembersByWineryId(
        wineryId,
        toPrismaPage(query),
      );

    const items = members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      fullName: m.user.fullName,
      email: m.user.email,
      memberRole: m.memberRole,
      professionalLicenseNumber: m.professionalLicenseNumber,
      isActive: m.isActive,
      joinedAt: m.joinedAt,
    }));
    return toPage(items, total, query);
  }

  /**
   * Lista todas las bodegas pendientes de aprobación (Solo Platform Admin)
   */
  async getPendingWineries(
    query: PaginationQueryDto,
  ): Promise<Paginated<WineryResponseDto>> {
    const [wineries, total] = await this.wineryRepository.findPendingWineries(
      toPrismaPage(query),
    );
    return toPage(
      wineries.map((w) => this.mapToWineryResponse(w)),
      total,
      query,
    );
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

    if (winery.certificationStatus !== WineryStatusEnum.INVITED) {
      throw new AppConflictException(
        ErrorCode.WINERY_NOT_PENDING,
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

    // Estado, prefijo de lote, organización, historial y bitácora en una
    // transacción (una bodega ACTIVE siempre tiene su prefijo, ORG-05)
    const approvedWinery = await this.prisma.$transaction(async (tx) => {
      await ensureLotPrefix(tx, winery);
      const now = new Date();
      const updated = await this.wineryRepository.update(
        wineryId,
        {
          certificationStatus: WineryStatusEnum.ACTIVE,
          approvedAt: now,
          activatedAt: winery.activatedAt ?? now,
          approvedByUser: { connect: { id: adminUserId } },
          onchainProducerId: onchainResult.onchainProducerId,
          onchainRegisterTxHash: onchainResult.txHash,
        },
        tx,
      );
      await this.organizations.syncWinery(tx, updated);
      await tx.wineryStatusChange.create({
        data: {
          wineryId,
          status: WineryStatusEnum.ACTIVE,
          byUserId: adminUserId,
          byName: await this.userName(tx, adminUserId),
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPROVED,
        resource: { type: 'winery', id: wineryId },
        organizationId: wineryId,
        before: { certificationStatus: winery.certificationStatus },
        after: {
          certificationStatus: updated.certificationStatus,
          approvedAt: updated.approvedAt,
          lotPrefix: updated.lotPrefix,
          onchainProducerId: updated.onchainProducerId,
          onchainRegisterTxHash: updated.onchainRegisterTxHash,
        },
      });
      return updated;
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

    if (winery.certificationStatus !== WineryStatusEnum.INVITED) {
      throw new AppConflictException(
        ErrorCode.WINERY_NOT_PENDING,
        `La bodega se encuentra en estado '${winery.certificationStatus}' y no puede ser rechazada`,
      );
    }

    const rejectedWinery = await this.prisma.$transaction(async (tx) => {
      const updated = await this.wineryRepository.update(
        wineryId,
        {
          certificationStatus: WineryStatusEnum.REVOKED,
          approvedAt: new Date(),
          approvedByUser: { connect: { id: adminUserId } },
        },
        tx,
      );
      await this.organizations.syncWinery(tx, updated);
      await tx.wineryStatusChange.create({
        data: {
          wineryId,
          status: WineryStatusEnum.REVOKED,
          byUserId: adminUserId,
          byName: await this.userName(tx, adminUserId),
          reason: dto.rejectionReason,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.WINERY_REJECTED,
        resource: { type: 'winery', id: wineryId },
        organizationId: wineryId,
        before: { certificationStatus: winery.certificationStatus },
        after: { certificationStatus: updated.certificationStatus },
        reason: dto.rejectionReason,
      });
      return updated;
    });
    // Organización revocada: fuera las sesiones que la tienen activa
    await this.sessions.revokeForOrganization(
      wineryId,
      RevocationReason.ORGANIZATION_REVOKED,
    );

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
          wallets: true,
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

  private async userName(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    return user?.fullName ?? 'Sistema';
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
