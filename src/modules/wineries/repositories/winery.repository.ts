import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { Winery, WineryStatusEnum, Prisma } from '@prisma/client';

@Injectable()
export class WineryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `tx`: cliente de una transacción en curso (OP-01). */
  async create(
    data: Prisma.WineryCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Winery> {
    return (tx ?? this.prisma).winery.create({ data });
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

  /** Bodegas pendientes de aprobación (INVITED, una página) y su total. */
  async findPendingWineries(page: {
    take: number;
    skip: number;
  }): Promise<[Winery[], number]> {
    const where: Prisma.WineryWhereInput = {
      certificationStatus: WineryStatusEnum.INVITED,
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

  async update(
    id: string,
    data: Prisma.WineryUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Winery> {
    return (tx ?? this.prisma).winery.update({
      where: { id },
      data,
    });
  }
}
