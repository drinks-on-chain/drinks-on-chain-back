import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CreateTerroirDto } from './dto/create-terroir.dto';
import { UpdateTerroirDto } from './dto/update-terroir.dto';
import { QueryTerroirsDto } from './dto/query-terroirs.dto';
import { Prisma, Terroir } from '@prisma/client';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';

@Injectable()
export class TerroirsService {
  private readonly logger = new Logger(TerroirsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(wineryId: string, dto: CreateTerroirDto): Promise<Terroir> {
    this.logger.log(
      `Registrando parcela "${dto.parcelName}" para la bodega ${wineryId}`,
    );

    const terroir = await this.audit.transaction(
      (tx) =>
        tx.terroir.create({
          data: {
            wineryId,
            parcelName: dto.parcelName,
            cadastreCode: dto.cadastreCode,
            surfaceHectares: new Prisma.Decimal(dto.surfaceHectares),
            altitudeMasl: new Prisma.Decimal(dto.altitudeMasl),
            latitude:
              dto.latitude !== undefined
                ? new Prisma.Decimal(dto.latitude)
                : null,
            longitude:
              dto.longitude !== undefined
                ? new Prisma.Decimal(dto.longitude)
                : null,
            geographicPolygonGeojson:
              dto.geographicPolygonGeojson ?? Prisma.DbNull,
            rawMaterialType: dto.rawMaterialType,
            varietyName: dto.varietyName,
            soilType: dto.soilType,
            irrigationSystem: dto.irrigationSystem,
            isDoEligible: dto.isDoEligible ?? false,
            doType: dto.doType,
            doCertificateUrl: dto.doCertificateUrl,
          },
        }),
      (created) => ({
        action: AuditAction.TERROIR_CREATED,
        resource: { type: 'terroir', id: created.id },
        organizationId: wineryId,
        after: created,
      }),
    );

    return terroir;
  }

  async findAll(
    wineryId: string | undefined,
    query: QueryTerroirsDto,
  ): Promise<Paginated<Terroir>> {
    const where: Prisma.TerroirWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.isDoEligible !== undefined && {
        isDoEligible: query.isDoEligible,
      }),
      ...(query.isActive !== undefined && { isActive: query.isActive }),
      ...(query.rawMaterialType && {
        rawMaterialType: { equals: query.rawMaterialType, mode: 'insensitive' },
      }),
      ...(query.varietyName && {
        varietyName: { contains: query.varietyName, mode: 'insensitive' },
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.terroir.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.terroir.count({ where }),
    ]);

    return toPage(items, total, query);
  }

  async findById(wineryId: string | undefined, id: string) {
    const terroir = await this.prisma.terroir.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        harvestBatches: {
          orderBy: { intakeDate: 'desc' },
        },
      },
    });

    if (!terroir) {
      throw new NotFoundException(
        `Parcela con ID ${id} no encontrada en esta bodega`,
      );
    }

    return terroir;
  }

  async update(
    wineryId: string,
    id: string,
    dto: UpdateTerroirDto,
  ): Promise<Terroir> {
    const before = await this.findById(wineryId, id);

    const updateData: Prisma.TerroirUpdateInput = {
      ...(dto.parcelName && { parcelName: dto.parcelName }),
      ...(dto.cadastreCode !== undefined && { cadastreCode: dto.cadastreCode }),
      ...(dto.surfaceHectares !== undefined && {
        surfaceHectares: new Prisma.Decimal(dto.surfaceHectares),
      }),
      ...(dto.altitudeMasl !== undefined && {
        altitudeMasl: new Prisma.Decimal(dto.altitudeMasl),
      }),
      ...(dto.latitude !== undefined && {
        latitude:
          dto.latitude !== null ? new Prisma.Decimal(dto.latitude) : null,
      }),
      ...(dto.longitude !== undefined && {
        longitude:
          dto.longitude !== null ? new Prisma.Decimal(dto.longitude) : null,
      }),
      ...(dto.geographicPolygonGeojson !== undefined && {
        geographicPolygonGeojson: dto.geographicPolygonGeojson ?? Prisma.DbNull,
      }),
      ...(dto.rawMaterialType && { rawMaterialType: dto.rawMaterialType }),
      ...(dto.varietyName && { varietyName: dto.varietyName }),
      ...(dto.soilType !== undefined && { soilType: dto.soilType }),
      ...(dto.irrigationSystem !== undefined && {
        irrigationSystem: dto.irrigationSystem,
      }),
      ...(dto.isDoEligible !== undefined && { isDoEligible: dto.isDoEligible }),
      ...(dto.doType !== undefined && { doType: dto.doType }),
      ...(dto.doCertificateUrl !== undefined && {
        doCertificateUrl: dto.doCertificateUrl,
      }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };

    return this.audit.transaction(
      (tx) => tx.terroir.update({ where: { id }, data: updateData }),
      (updated) => ({
        action: AuditAction.TERROIR_UPDATED,
        resource: { type: 'terroir', id },
        organizationId: updated.wineryId,
        before,
        after: updated,
      }),
    );
  }
}
