import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { WineryMember, WineryMemberRoleEnum } from '@prisma/client';

@Injectable()
export class WineryMemberRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    userId: string;
    wineryId: string;
    memberRole: WineryMemberRoleEnum;
    professionalLicenseNumber?: string;
    professionalLicensePdfUrl?: string;
  }): Promise<WineryMember> {
    return this.prisma.wineryMember.create({
      data: {
        userId: data.userId,
        wineryId: data.wineryId,
        memberRole: data.memberRole,
        professionalLicenseNumber: data.professionalLicenseNumber ?? null,
        professionalLicensePdfUrl: data.professionalLicensePdfUrl ?? null,
        isActive: true,
      },
    });
  }

  async findMembership(
    userId: string,
    wineryId: string,
  ): Promise<WineryMember | null> {
    return this.prisma.wineryMember.findUnique({
      where: {
        userId_wineryId: {
          userId,
          wineryId,
        },
      },
    });
  }

  async findMembersByWineryId(wineryId: string) {
    return this.prisma.wineryMember.findMany({
      where: { wineryId, isActive: true },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }
}
