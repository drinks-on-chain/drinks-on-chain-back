import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { Winery, Prisma } from '@prisma/client';

@Injectable()
export class WineryRepository {
  constructor(private readonly prisma: PrismaService) {}

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
