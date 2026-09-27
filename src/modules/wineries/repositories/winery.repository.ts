import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { Winery, WineryStatusEnum, Prisma } from '@prisma/client';

@Injectable()
export class WineryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.WineryCreateInput): Promise<Winery> {
    return this.prisma.winery.create({ data });
  }

  async findById(id: string) {
    return this.prisma.winery.findUnique({
      where: { id },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
              },
            },
          },
        },
      },
    });
  }

  async findByTaxId(taxIdNit: string): Promise<Winery | null> {
    return this.prisma.winery.findUnique({
      where: { taxIdNit: taxIdNit.trim() },
    });
  }

  /** Bodegas pendientes de aprobación (una página) y su total. */
  async findPendingWineries(page: {
    take: number;
    skip: number;
  }): Promise<[Winery[], number]> {
    const where: Prisma.WineryWhereInput = {
      certificationStatus: WineryStatusEnum.PENDING,
    };
    return Promise.all([
      this.prisma.winery.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...page,
      }),
      this.prisma.winery.count({ where }),
    ]);
  }

  async update(id: string, data: Prisma.WineryUpdateInput): Promise<Winery> {
    return this.prisma.winery.update({
      where: { id },
      data,
    });
  }
}
