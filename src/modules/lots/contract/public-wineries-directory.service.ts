import { Injectable } from '@nestjs/common';
import { Prisma, WineryStatusEnum } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { toPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { PublicWineryProfileDto } from '@modules/winery-management/dto/winery.dto';
import { toPublicProfile } from '@modules/winery-management/winery-view';
import { PublicWineriesQueryDto } from './dto/public-wineries.dto';

/**
 * Directorio público de bodegas (`GET /v1/public/wineries`, contrato O2
 * §12.1): solo bodegas `ACTIVE`, con la misma forma que
 * `GET /v1/public/wineries/{slug}`.
 */
@Injectable()
export class PublicWineriesDirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: PublicWineriesQueryDto,
  ): Promise<Paginated<PublicWineryProfileDto>> {
    const where: Prisma.WineryWhereInput = {
      certificationStatus: WineryStatusEnum.ACTIVE,
      ...(query.category ? { beverageCategory: query.category } : {}),
      ...(query.region
        ? {
            geographicRegion: { contains: query.region, mode: 'insensitive' },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.winery.findMany({
        where,
        select: {
          slug: true,
          commercialName: true,
          geographicRegion: true,
          beverageCategory: true,
          logoUrl: true,
          publicStory: true,
          website: true,
        },
        orderBy: [{ commercialName: 'asc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.winery.count({ where }),
    ]);
    return toPage(rows.map(toPublicProfile), total, query);
  }
}
