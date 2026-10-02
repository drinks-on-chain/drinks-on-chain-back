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
import { ErrorCode } from '@shared/exceptions/error-codes';
import {
  effectiveDoRules,
  terroirDo,
  TerroirDoFields,
} from '@modules/lots/do-rules';
import { stateError, violation } from '@modules/lots/domain/trace-errors';
import {
  CorrectionMarks,
  correctionMarks,
  withMarks,
} from '@modules/lots/correction-marks';

/** Campos con efecto normativo: no se cambian por `PATCH` en una parcela usada (§3.1). */
const NORMATIVE_FIELDS = [
  'altitudeMasl',
  'varietyName',
  'rawMaterialType',
] as const;

@Injectable()
export class TerroirsService {
  private readonly logger = new Logger(TerroirsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Añade la aptitud D.O. calculada con los valores efectivos de la bodega
   * (EA-03): `isDoEligible` ya no es un dato declarado.
   */
  private async withDo<T extends Terroir>(
    terroirs: T[],
  ): Promise<(T & TerroirDoFields & CorrectionMarks)[]> {
    // Marcas de corrección (§9): los campos normativos corregidos de la parcela
    const marks = await correctionMarks(
      this.prisma,
      'TERROIR',
      terroirs.map((t) => t.id),
    );
    const rulesByWinery = new Map<
      string,
      Awaited<ReturnType<typeof effectiveDoRules>>
    >();
    const now = new Date();
    const out: (T & TerroirDoFields & CorrectionMarks)[] = [];
    for (const t of terroirs) {
      let rules = rulesByWinery.get(t.wineryId);
      if (!rules) {
        rules = await effectiveDoRules(this.prisma, t.wineryId);
        rulesByWinery.set(t.wineryId, rules);
      }
      out.push({ ...withMarks(t, marks), ...terroirDo(t, rules, now) });
    }
    return out;
  }

  async create(
    wineryId: string,
    dto: CreateTerroirDto,
  ): Promise<Terroir & TerroirDoFields> {
    this.logger.log(
      `Registrando parcela "${dto.parcelName}" para la bodega ${wineryId}`,
    );
    // La aptitud D.O. no es un dato de la entrada (§3.1): se calcula aquí
    const rules = await effectiveDoRules(this.prisma, wineryId);
    const computed = terroirDo(
      {
        id: 'nueva',
        altitudeMasl: dto.altitudeMasl,
        varietyName: dto.varietyName,
      },
      rules,
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
            isDoEligible: computed.isDoEligible,
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

    return (await this.withDo([terroir]))[0];
  }

  async findAll(
    wineryId: string | undefined,
    query: QueryTerroirsDto,
  ): Promise<Paginated<Terroir & TerroirDoFields>> {
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

    return toPage(await this.withDo(items), total, query);
  }

  async findById(wineryId: string | undefined, id: string) {
    const terroir = await this.findRow(wineryId, id);
    return (await this.withDo([terroir]))[0];
  }

  private async findRow(wineryId: string | undefined, id: string) {
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
  ): Promise<Terroir & TerroirDoFields> {
    const before = await this.findRow(wineryId, id);

    // Parcela usada: sus campos normativos se corrigen con un registro
    // compensatorio (§3.1, §9), no con PATCH
    const changed = NORMATIVE_FIELDS.filter((field) => {
      const next = dto[field];
      if (next === undefined || next === null) return false;
      const current = before[field];
      return field === 'altitudeMasl'
        ? Number(current) !== Number(next)
        : String(current) !== String(next);
    });
    if (changed.length > 0 && before.harvestBatches.length > 0) {
      throw stateError(
        ErrorCode.TRC_TERROIR_IN_USE,
        'La parcela ya tiene pesajes: altitud, cepa y materia prima se corrigen con una corrección (POST /v1/terroirs/{id}/corrections)',
        changed.map((field) =>
          violation(
            ErrorCode.TRC_TERROIR_IN_USE,
            `Campo normativo de una parcela usada: ${field}`,
            {
              field,
              meta: {
                fields: changed,
                harvestBatches: before.harvestBatches.length,
              },
            },
          ),
        ),
      );
    }
    const rules = await effectiveDoRules(this.prisma, before.wineryId);
    const computed = terroirDo(
      {
        id,
        altitudeMasl: dto.altitudeMasl ?? before.altitudeMasl,
        varietyName: dto.varietyName ?? before.varietyName,
      },
      rules,
    );

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
      // La aptitud D.O. se recalcula con cada edición (EA-03)
      isDoEligible: computed.isDoEligible,
      ...(dto.doType !== undefined && { doType: dto.doType }),
      ...(dto.doCertificateUrl !== undefined && {
        doCertificateUrl: dto.doCertificateUrl,
      }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };

    const { harvestBatches: _used, ...beforeRow } = before;
    void _used;
    const updated = await this.audit.transaction(
      (tx) => tx.terroir.update({ where: { id }, data: updateData }),
      (updated) => ({
        action: AuditAction.TERROIR_UPDATED,
        resource: { type: 'terroir', id },
        organizationId: updated.wineryId,
        before: beforeRow,
        after: updated,
      }),
    );
    return (await this.withDo([updated]))[0];
  }
}
