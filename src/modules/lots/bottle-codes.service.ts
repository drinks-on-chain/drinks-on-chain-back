import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BottleUnit, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { OutboxService } from '@shared/outbox/outbox.service';
import { QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type {
  ErrorDetail,
  Paginated,
} from '@shared/interfaces/api-response.interface';
import { toPage } from '@shared/dto/pagination-query.dto';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import { passportUrl, resolvePassportBaseUrl } from './bottle-units';
import { BottleCsvContext, bottleExportFilename } from './domain/bottle-csv';
import {
  CROCKFORD_ALPHABET,
  formatBottleCode,
  generateBottleCode,
  generateBottleSalt,
  isValidBottleCode,
  normalizeBottleCode,
} from './domain/bottle-code';
import { dateOnly } from './domain/dates';
import {
  lotNotFound,
  stateError,
  TraceRuleException,
  violation,
} from './domain/trace-errors';
import { appendLotEvent } from './lot-events';
import { lockedClock } from './lot-dossier';
import { lockLot } from './lot-records';
import {
  BOTTLE_CODES_EXPORT_JOB,
  BottleCodesExportPayload,
} from './lots.events';
import { actorOf, resolveTraceActors, TraceActor } from './trace-actors';
import { actorMembership, DbClient, dbClock } from './trace-db';

type Tx = Prisma.TransactionClient;

/** Los ZIP caducan a los 7 días (contrato O2 §15). */
export const BOTTLE_EXPORT_TTL_DAYS = 7;
/** URL firmada de la descarga: 15 minutos (§7.2). */
export const BOTTLE_EXPORT_URL_TTL_SECONDS = 900;
/**
 * Códigos por exportación ZIP: el archivo se arma en memoria y el formato
 * ZIP clásico admite 65 535 entradas; un lote mayor se exporta por rangos.
 */
export const BOTTLE_ZIP_MAX_CODES = 20_000;
/** Filas por consulta al enviar el CSV (streaming). */
const CSV_BATCH_SIZE = 1_000;
/** Registrar una exportación marca hasta 100 000 códigos (contadores). */
const EXPORT_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

export interface BottleUnitView {
  code: string;
  codeFormatted: string;
  serial: number;
  lotId: string;
  lotCode: string;
  status: 'ACTIVE' | 'VOIDED';
  qrUrl: string;
  voided: {
    at: string;
    by: TraceActor | null;
    reason: string;
    replacedBy: string | null;
  } | null;
  replaces: string | null;
  exportsCount: number;
  firstExportedAt: string | null;
}

export interface BottleCodeExportView {
  exportId: string;
  status: 'PENDING' | 'READY' | 'FAILED';
  format: 'CSV' | 'ZIP';
  fromSerial: number;
  toSerial: number;
  rows: number;
  createdAt: string;
  createdBy: TraceActor | null;
  downloadUrl: string | null;
  expiresAt: string;
}

export interface SerialRange {
  fromSerial: number;
  toSerial: number;
}

export interface BottleCodeQuery {
  status?: 'ACTIVE' | 'VOIDED';
  fromSerial?: number;
  toSerial?: number;
  q?: string;
  limit: number;
  offset: number;
}

export interface CsvExport {
  exportId: string;
  filename: string;
  rows: number;
  lotId: string;
  range: SerialRange;
  context: BottleCsvContext;
}

interface BottledLot {
  id: string;
  wineryId: string;
  name: string;
  lotCode: string;
  productType: string;
  stage: string;
  bottles: number;
  bottlingDate: string;
}

type UnitRow = BottleUnit;

/**
 * Clave del ZIP de una exportación en el almacenamiento privado. Fuera del
 * prefijo `org/…` de las subidas: `GET /v1/uploads/url` no la firma, solo
 * `GET …/bottle-codes/exports/{exportId}` (OWNER y ENOLOGIST).
 */
export function bottleExportStorageKey(
  wineryId: string,
  exportId: string,
): string {
  return `exports/bottle-codes/${wineryId}/${exportId}.zip`;
}

/**
 * Rango de series de una consulta o exportación (§7.2): por defecto `1…N`;
 * `fromSerial > toSerial` o fuera de `1…N` → 422 `VALIDATION_ERROR`.
 */
export function resolveSerialRange(
  total: number,
  fromSerial: number | undefined,
  toSerial: number | undefined,
): SerialRange {
  const from = fromSerial ?? 1;
  const to = toSerial ?? total;
  const details: ErrorDetail[] = [];
  if (from < 1 || from > total) {
    details.push({
      field: 'fromSerial',
      message: `fromSerial debe estar entre 1 y ${total}`,
    });
  }
  if (to < 1 || to > total) {
    details.push({
      field: 'toSerial',
      message: `toSerial debe estar entre 1 y ${total}`,
    });
  }
  if (details.length === 0 && from > to) {
    details.push({
      field: 'fromSerial',
      message: 'fromSerial no puede ser mayor que toSerial',
    });
  }
  if (details.length > 0) {
    throw new ValidationException(details, 'Rango de series inválido');
  }
  return { fromSerial: from, toSerial: to };
}

/**
 * Códigos de botella (contrato O2 §7; ERP-15, A-26): listado y búsqueda,
 * exportación CSV (streaming) y ZIP para la imprenta (en el worker), y
 * anulación con o sin sustituto. Cada exportación y cada anulación queda en
 * la bitácora con su rango: los códigos son el antifalsificación de la
 * etiqueta.
 */
@Injectable()
export class BottleCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
  ) {}

  private passportBaseUrl(): string {
    return resolvePassportBaseUrl({
      PASSPORT_BASE_URL: this.config.get<string>('PASSPORT_BASE_URL'),
      APP_URL_MARKETPLACE: this.config.get<string>('APP_URL_MARKETPLACE'),
    });
  }

  // ── Listado y búsqueda ───────────────────────────────────────────────────

  async list(
    wineryId: string | undefined,
    lotId: string,
    query: BottleCodeQuery,
  ): Promise<Paginated<BottleUnitView>> {
    const lot = await bottledLot(this.prisma, wineryId, lotId);
    const range = resolveSerialRange(
      lot.bottles,
      query.fromSerial,
      query.toSerial,
    );
    const where: Prisma.BottleUnitWhereInput = {
      lotId: lot.id,
      serial: { gte: range.fromSerial, lte: range.toSerial },
      ...(query.status && { status: query.status }),
      ...searchFilter(query.q),
    };
    const [rows, total] = await Promise.all([
      this.prisma.bottleUnit.findMany({
        where,
        orderBy: [{ serial: 'asc' }, { createdAt: 'asc' }, { code: 'asc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.bottleUnit.count({ where }),
    ]);
    const actors = await resolveTraceActors(
      this.prisma,
      rows.map((r) => r.voidedByMembershipId),
    );
    const baseUrl = this.passportBaseUrl();
    return toPage(
      rows.map((row) => toUnitView(row, lot.lotCode, actors, baseUrl)),
      total,
      query,
    );
  }

  // ── Exportación CSV ──────────────────────────────────────────────────────

  /**
   * Registra la exportación CSV (fila en `bottle_code_exports`, contadores de
   * los códigos y bitácora) antes de enviar nada: sin su entrada en la
   * bitácora no hay exportación. Las filas se envían después por partes
   * (`csvBatches`).
   */
  async prepareCsvExport(
    wineryId: string,
    lotId: string,
    userId: string,
    input: { fromSerial?: number; toSerial?: number },
  ): Promise<CsvExport> {
    const baseUrl = this.passportBaseUrl();
    return this.prisma.$transaction(async (tx) => {
      await lockLot(tx, lotId, wineryId);
      const lot = await bottledLot(tx, wineryId, lotId);
      const range = resolveSerialRange(
        lot.bottles,
        input.fromSerial,
        input.toSerial,
      );
      const exported = await this.registerExport(tx, lot, userId, range, {
        format: 'CSV',
        status: 'READY',
        options: {},
      });
      return {
        exportId: exported.id,
        filename: bottleExportFilename(lot.lotCode, range, 'csv'),
        rows: exported.rows,
        lotId: lot.id,
        range,
        context: csvContext(lot, baseUrl),
      };
    }, EXPORT_TX_OPTIONS);
  }

  /** Códigos activos del rango, por serie, en tandas (para el streaming). */
  async *csvBatches(
    lotId: string,
    range: SerialRange,
  ): AsyncGenerator<{ serial: number; code: string }[]> {
    yield* activeCodeBatches(this.prisma, lotId, range, CSV_BATCH_SIZE);
  }

  // ── Exportación ZIP (worker) ─────────────────────────────────────────────

  async requestZipExport(
    wineryId: string,
    lotId: string,
    userId: string,
    input: {
      fromSerial?: number;
      toSerial?: number;
      qr: { imageFormat: 'SVG' | 'PNG'; sizePx?: number; margin?: number };
    },
  ): Promise<{ exportId: string; status: 'PENDING' }> {
    const passportBaseUrl = this.passportBaseUrl();
    return this.prisma.$transaction(async (tx) => {
      await lockLot(tx, lotId, wineryId);
      const lot = await bottledLot(tx, wineryId, lotId);
      const range = resolveSerialRange(
        lot.bottles,
        input.fromSerial,
        input.toSerial,
      );
      const exported = await this.registerExport(tx, lot, userId, range, {
        format: 'ZIP',
        status: 'PENDING',
        options: {
          // El worker arma las URL con la base de la API, no con la suya
          passportBaseUrl,
          qr: {
            imageFormat: input.qr.imageFormat,
            ...(input.qr.sizePx !== undefined && { sizePx: input.qr.sizePx }),
            ...(input.qr.margin !== undefined && { margin: input.qr.margin }),
          },
        },
        maxRows: BOTTLE_ZIP_MAX_CODES,
        beforeAudit: async (exportId) => {
          await this.outbox.add<BottleCodesExportPayload>(tx, {
            type: BOTTLE_CODES_EXPORT_JOB,
            aggregateType: 'bottle_code_export',
            aggregateId: exportId,
            payload: { exportId, lotId: lot.id, wineryId: lot.wineryId },
            queue: QUEUE_DEFAULT,
          });
        },
      });
      return { exportId: exported.id, status: 'PENDING' as const };
    }, EXPORT_TX_OPTIONS);
  }

  async getExport(
    wineryId: string | undefined,
    lotId: string,
    exportId: string,
  ): Promise<BottleCodeExportView> {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, ...(wineryId && { wineryId }) },
      select: {
        id: true,
        bottlingBatch: { select: { totalBottlesPackaged: true } },
      },
    });
    if (!lot) throw lotNotFound();
    const row = await this.prisma.bottleCodeExport.findFirst({
      where: { id: exportId, lotId: lot.id },
    });
    if (!row) {
      throw new AppException(
        404,
        ErrorCode.NOT_FOUND,
        'Exportación no encontrada en este lote',
      );
    }
    const actors = await resolveTraceActors(this.prisma, [
      row.createdByMembershipId,
    ]);
    const expiresAt =
      row.expiresAt ??
      new Date(row.createdAt.getTime() + BOTTLE_EXPORT_TTL_DAYS * 86_400_000);
    let downloadUrl: string | null = null;
    if (
      row.status === 'READY' &&
      row.storageKey &&
      expiresAt.getTime() > Date.now()
    ) {
      downloadUrl = (
        await this.storage.getSignedUrl(
          row.storageKey,
          BOTTLE_EXPORT_URL_TTL_SECONDS,
        )
      ).url;
    }
    return {
      exportId: row.id,
      status: row.status as BottleCodeExportView['status'],
      format: row.format === 'ZIP' ? 'ZIP' : 'CSV',
      fromSerial: row.fromSerial ?? 1,
      toSerial: row.toSerial ?? lot.bottlingBatch?.totalBottlesPackaged ?? 1,
      rows: row.rows,
      createdAt: row.createdAt.toISOString(),
      createdBy: actorOf(actors, row.createdByMembershipId),
      downloadUrl,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Fila de la exportación, contadores de los códigos exportados y bitácora
   * (`BOTTLE_CODES_EXPORTED` con el rango), en la transacción `tx`.
   */
  private async registerExport(
    tx: Tx,
    lot: BottledLot,
    userId: string,
    range: SerialRange,
    options: {
      format: 'CSV' | 'ZIP';
      status: 'READY' | 'PENDING';
      options: Prisma.InputJsonObject;
      maxRows?: number;
      beforeAudit?: (exportId: string) => Promise<void>;
    },
  ): Promise<{ id: string; rows: number }> {
    const inRange: Prisma.BottleUnitWhereInput = {
      lotId: lot.id,
      status: 'ACTIVE',
      serial: { gte: range.fromSerial, lte: range.toSerial },
    };
    const rows = await tx.bottleUnit.count({ where: inRange });
    if (rows === 0) {
      throw ValidationException.forField(
        'fromSerial',
        'No hay códigos activos en ese rango de series',
      );
    }
    if (options.maxRows !== undefined && rows > options.maxRows) {
      throw ValidationException.forField(
        'toSerial',
        `Una exportación ${options.format} admite como máximo ${options.maxRows} códigos (el rango tiene ${rows}): expórtalo por rangos de serie`,
      );
    }
    const clock = await dbClock(tx);
    const membership = await actorMembership(tx, userId, lot.wineryId);
    const created = await tx.bottleCodeExport.create({
      data: {
        lotId: lot.id,
        format: options.format,
        fromSerial: range.fromSerial,
        toSerial: range.toSerial,
        options: options.options,
        status: options.status,
        rows,
        createdAt: clock.now,
        createdByMembershipId: membership?.id ?? null,
        expiresAt: new Date(
          clock.now.getTime() + BOTTLE_EXPORT_TTL_DAYS * 86_400_000,
        ),
      },
      select: { id: true },
    });
    await tx.bottleUnit.updateMany({
      where: { ...inRange, firstExportedAt: null },
      data: { firstExportedAt: clock.now },
    });
    await tx.bottleUnit.updateMany({
      where: inRange,
      data: { exportsCount: { increment: 1 } },
    });
    await options.beforeAudit?.(created.id);
    await this.audit.record(tx, {
      action: AuditAction.BOTTLE_CODES_EXPORTED,
      resource: { type: 'bottle_code_export', id: created.id },
      organizationId: lot.wineryId,
      after: {
        lotId: lot.id,
        lotCode: lot.lotCode,
        format: options.format,
        fromSerial: range.fromSerial,
        toSerial: range.toSerial,
        rows,
        ...options.options,
      },
    });
    return { id: created.id, rows };
  }

  // ── Anulación ────────────────────────────────────────────────────────────

  /**
   * Anula un código (§7.2). Con `replace`, emite un código nuevo con la misma
   * serie (etiqueta dañada). Con el expediente cerrado se puede anular pero
   * no sustituir (S-14): la raíz Merkle del expediente ya está fijada.
   */
  async voidCode(
    wineryId: string,
    rawCode: string,
    userId: string,
    input: { reason: string; replace?: boolean },
  ): Promise<BottleUnitView> {
    const code = normalizeBottleCode(rawCode);
    if (!isValidBottleCode(code)) {
      throw codeNotFound(
        'El código no tiene 8 caracteres válidos o su carácter de control no coincide',
      );
    }
    const baseUrl = this.passportBaseUrl();
    const reason = input.reason.trim();
    const replace = input.replace === true;
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.bottleUnit.findFirst({
        where: { code, lot: { wineryId } },
        select: { lotId: true },
      });
      if (!found) throw codeNotFound();
      const lot = await lockLot(tx, found.lotId, wineryId);
      // Con el lote bloqueado: el estado del código ya no cambia por debajo
      const unit = await tx.bottleUnit.findUniqueOrThrow({ where: { code } });
      if (unit.status === 'VOIDED') {
        throw stateError(
          ErrorCode.TRC_BOTTLE_CODE_ALREADY_VOIDED,
          'El código ya estaba anulado',
          [
            violation(
              ErrorCode.TRC_BOTTLE_CODE_ALREADY_VOIDED,
              'Código anulado',
              {
                meta: {
                  voidedAt: unit.voidedAt?.toISOString() ?? null,
                  replacedBy: unit.replacedByCode,
                },
              },
            ),
          ],
        );
      }
      const dossier = await tx.lotDossier.findUnique({
        where: { lotId: lot.id },
        select: { status: true, closedAt: true },
      });
      if (replace && dossier?.status === 'CLOSED') {
        throw stateError(
          ErrorCode.TRC_DOSSIER_CLOSED,
          'El expediente del lote está cerrado: el código se puede anular, pero no sustituir',
          [
            violation(
              ErrorCode.TRC_DOSSIER_CLOSED,
              'Con el expediente cerrado no se emiten códigos nuevos (S-14)',
              {
                field: 'replace',
                meta: { closedAt: dossier.closedAt?.toISOString() ?? null },
              },
            ),
          ],
        );
      }
      // Con el lote bloqueado: la fecha de la anulación ordena frente al cierre
      const clock = await lockedClock(tx);
      const membership = await actorMembership(tx, userId, wineryId);
      // Primero la baja: una serie solo tiene un código activo (índice único
      // parcial `bottle_units_lot_id_serial_active_key`)
      await tx.bottleUnit.update({
        where: { id: unit.id },
        data: {
          status: 'VOIDED',
          voidedAt: clock.now,
          voidedByMembershipId: membership?.id ?? null,
          voidReason: reason,
        },
      });
      const replacement = replace ? await createReplacement(tx, unit) : null;
      const voided = await tx.bottleUnit.update({
        where: { id: unit.id },
        data: { replacedByCode: replacement },
      });
      await tx.lot.update({
        where: { id: lot.id },
        data: { updatedAt: clock.now },
      });
      await appendLotEvent(tx, lot.id, {
        type: 'BOTTLE_CODE_VOIDED',
        occurredAt: clock.now,
        stage: lot.stage,
        actorMembershipId: membership?.id ?? null,
        summary: replacement
          ? `Código de la botella n.º ${unit.serial} anulado y sustituido`
          : `Código de la botella n.º ${unit.serial} anulado`,
        // Sin el código: la línea de tiempo la ven roles que solo ven totales
        data: { serial: unit.serial, replaced: replacement !== null, reason },
        resource: { type: 'bottle_unit', id: unit.id },
      });
      await this.audit.record(tx, {
        action: AuditAction.BOTTLE_CODE_VOIDED,
        resource: { type: 'bottle_unit', id: unit.code },
        organizationId: wineryId,
        before: { code: unit.code, serial: unit.serial, status: 'ACTIVE' },
        after: {
          lotId: lot.id,
          lotCode: lot.lotCode,
          code: unit.code,
          serial: unit.serial,
          fromSerial: unit.serial,
          toSerial: unit.serial,
          status: 'VOIDED',
          replacedBy: replacement,
        },
        reason,
      });
      const actors = await resolveTraceActors(tx, [
        voided.voidedByMembershipId,
      ]);
      return toUnitView(voided, lot.lotCode ?? '', actors, baseUrl);
    }, AUDIT_TX_OPTIONS);
  }
}

/** Lote embotellado de la bodega: 404 si no existe, 409 si aún no hay embotellado. */
export async function bottledLot(
  client: DbClient,
  wineryId: string | undefined,
  lotId: string,
): Promise<BottledLot> {
  const lot = await client.lot.findFirst({
    where: { id: lotId, ...(wineryId && { wineryId }) },
    select: {
      id: true,
      wineryId: true,
      name: true,
      lotCode: true,
      productType: true,
      stage: true,
      bottlingBatch: {
        select: {
          internationalLotCode: true,
          totalBottlesPackaged: true,
          bottlingDate: true,
          productType: true,
        },
      },
    },
  });
  if (!lot) throw lotNotFound();
  if (!lot.bottlingBatch) {
    throw stateError(
      ErrorCode.TRC_LOT_NOT_BOTTLED,
      'El lote aún no está embotellado: los códigos de botella se generan al embotellar',
      [
        violation(ErrorCode.TRC_LOT_NOT_BOTTLED, 'Lote sin embotellar', {
          meta: { stage: lot.stage },
        }),
      ],
    );
  }
  return {
    id: lot.id,
    wineryId: lot.wineryId,
    name: lot.name,
    lotCode: lot.lotCode ?? lot.bottlingBatch.internationalLotCode,
    productType: lot.productType ?? lot.bottlingBatch.productType,
    stage: lot.stage,
    bottles: lot.bottlingBatch.totalBottlesPackaged,
    bottlingDate: dateOnly(lot.bottlingBatch.bottlingDate),
  };
}

/** Datos comunes de las filas del CSV de un lote. */
export function csvContext(
  lot: Pick<BottledLot, 'lotCode' | 'name' | 'productType' | 'bottlingDate'>,
  passportBaseUrl: string,
): BottleCsvContext {
  return {
    lotCode: lot.lotCode,
    lotName: lot.name,
    productType: lot.productType,
    bottlingDate: lot.bottlingDate,
    qrUrl: (code) => passportUrl(passportBaseUrl, code),
  };
}

/** Códigos activos de un rango, por serie, en tandas de `size` (cursor por serie). */
export async function* activeCodeBatches(
  client: DbClient,
  lotId: string,
  range: SerialRange,
  size: number,
): AsyncGenerator<{ serial: number; code: string }[]> {
  let after = range.fromSerial - 1;
  for (;;) {
    const batch = await client.bottleUnit.findMany({
      where: {
        lotId,
        status: 'ACTIVE',
        serial: { gt: after, lte: range.toSerial },
      },
      orderBy: [{ serial: 'asc' }, { code: 'asc' }],
      take: size,
      select: { serial: true, code: true },
    });
    if (batch.length === 0) return;
    yield batch;
    after = batch[batch.length - 1].serial;
    if (batch.length < size) return;
  }
}

function codeNotFound(detail?: string): TraceRuleException {
  return new TraceRuleException(
    404,
    ErrorCode.TRC_BOTTLE_CODE_NOT_FOUND,
    'Código de botella no encontrado',
    detail
      ? [
          violation(ErrorCode.TRC_BOTTLE_CODE_NOT_FOUND, detail, {
            field: 'code',
          }),
        ]
      : [],
  );
}

/**
 * Filtro de búsqueda: un fragmento del código (normalizado) o el número de
 * serie exacto.
 */
function searchFilter(q: string | undefined): Prisma.BottleUnitWhereInput {
  if (!q) return {};
  const fragment = normalizeBottleCode(q);
  const or: Prisma.BottleUnitWhereInput[] = [];
  if (
    fragment.length > 0 &&
    [...fragment].every((c) => CROCKFORD_ALPHABET.includes(c))
  ) {
    or.push({ code: { contains: fragment } });
  }
  const digits = q.replace(/[\s.]/g, '');
  if (/^\d{1,9}$/.test(digits)) {
    or.push({ serial: Number(digits) });
  }
  // Nada que buscar (caracteres fuera del alfabeto): sin resultados
  return or.length > 0 ? { OR: or } : { serial: -1 };
}

/** Código nuevo con la misma serie que `unit` (único en toda la plataforma). */
async function createReplacement(tx: Tx, unit: UnitRow): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateBottleCode();
    const { count } = await tx.bottleUnit.createMany({
      data: [
        {
          code,
          serial: unit.serial,
          lotId: unit.lotId,
          bottlingBatchId: unit.bottlingBatchId,
          salt: generateBottleSalt(),
          replacesCode: unit.code,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return code;
  }
  throw new Error('No se pudo generar un código de botella único');
}

function toUnitView(
  row: UnitRow,
  lotCode: string,
  actors: Map<string, TraceActor>,
  passportBaseUrl: string,
): BottleUnitView {
  return {
    code: row.code,
    codeFormatted: formatBottleCode(row.code),
    serial: row.serial,
    lotId: row.lotId,
    lotCode,
    status: row.status,
    qrUrl: passportUrl(passportBaseUrl, row.code),
    voided:
      row.status === 'VOIDED'
        ? {
            at: (row.voidedAt ?? row.createdAt).toISOString(),
            by: actorOf(actors, row.voidedByMembershipId),
            reason: row.voidReason ?? '',
            replacedBy: row.replacedByCode,
          }
        : null,
    replaces: row.replacesCode,
    exportsCount: row.exportsCount,
    firstExportedAt: row.firstExportedAt
      ? row.firstExportedAt.toISOString()
      : null,
  };
}
