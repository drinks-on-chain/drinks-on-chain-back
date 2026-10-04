import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import { createObjectStorage } from '@shared/storage/storage.module';
import {
  activeCodeBatches,
  bottledLot,
  bottleExportStorageKey,
  csvContext,
} from './bottle-codes.service';
import { resolvePassportBaseUrl } from './bottle-units';
import { bottleCsvHeader, bottleCsvRow } from './domain/bottle-csv';
import {
  QR_DEFAULT_MARGIN,
  QR_DEFAULT_SIZE_PX,
  qrPng,
  qrSvg,
} from './domain/qr-image';
import { ZipWriter } from './domain/zip';

/** Códigos por consulta al armar el ZIP. */
const ZIP_BATCH_SIZE = 500;
/** Nombre del CSV dentro del ZIP. */
export const ZIP_CSV_NAME = 'codigos.csv';
/** Carpeta de las imágenes dentro del ZIP. */
export const ZIP_QR_FOLDER = 'qr';

export type BuildResult =
  | { status: 'READY'; rows: number; bytes: number; storageKey: string }
  | { status: 'SKIPPED'; reason: string };

interface QrOptions {
  imageFormat: 'SVG' | 'PNG';
  sizePx: number;
  margin: number;
}

function qrOptionsOf(options: unknown): QrOptions {
  const qr = (
    typeof options === 'object' && options !== null
      ? ((options as Record<string, unknown>).qr ?? {})
      : {}
  ) as Record<string, unknown>;
  return {
    imageFormat: qr.imageFormat === 'PNG' ? 'PNG' : 'SVG',
    sizePx: typeof qr.sizePx === 'number' ? qr.sizePx : QR_DEFAULT_SIZE_PX,
    margin: typeof qr.margin === 'number' ? qr.margin : QR_DEFAULT_MARGIN,
  };
}

/**
 * Arma el ZIP de una exportación de códigos de botella (contrato O2 §7.2 y
 * §15, tarea `trace.bottle-codes.export`): `codigos.csv` y una imagen de QR
 * por código activo del rango (`qr/{serie}-{código}.svg|png`). Lo guarda en
 * el almacenamiento privado y deja la exportación `READY`. Es idempotente:
 * una exportación ya lista no se rehace.
 *
 * En la API usa el almacenamiento del proceso; en el worker (que no carga
 * `StorageModule`) lo crea al primer trabajo con la misma configuración
 * (`STORAGE_DRIVER`, `S3_*`), así que un almacenamiento mal configurado solo
 * hace fallar las exportaciones, no el arranque del worker.
 */
@Injectable()
export class BottleCodeExportBuilder {
  private readonly logger = new Logger(BottleCodeExportBuilder.name);
  private storage: ObjectStorage | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() @Inject(STORAGE_SERVICE) storage?: ObjectStorage,
  ) {
    this.storage = storage ?? null;
  }

  private async objectStorage(): Promise<ObjectStorage> {
    if (!this.storage) {
      const storage = createObjectStorage(this.config);
      await storage.ensureReady();
      this.storage = storage;
    }
    return this.storage;
  }

  async build(exportId: string): Promise<BuildResult> {
    const row = await this.prisma.bottleCodeExport.findUnique({
      where: { id: exportId },
    });
    if (!row) return { status: 'SKIPPED', reason: 'la exportación no existe' };
    if (row.format !== 'ZIP') {
      return { status: 'SKIPPED', reason: 'no es una exportación ZIP' };
    }
    if (row.status === 'READY' && row.storageKey) {
      return { status: 'SKIPPED', reason: 'ya estaba lista' };
    }
    const lot = await bottledLot(this.prisma, undefined, row.lotId);
    const range = {
      fromSerial: row.fromSerial ?? 1,
      toSerial: row.toSerial ?? lot.bottles,
    };
    const qr = qrOptionsOf(row.options);
    // La base del QR la fijó la API al pedir la exportación
    const stored = (row.options as Record<string, unknown> | null)
      ?.passportBaseUrl;
    const context = csvContext(
      lot,
      typeof stored === 'string' && stored.length > 0
        ? stored
        : resolvePassportBaseUrl({
            PASSPORT_BASE_URL: this.config.get<string>('PASSPORT_BASE_URL'),
            APP_URL_MARKETPLACE: this.config.get<string>('APP_URL_MARKETPLACE'),
          }),
    );

    const zip = new ZipWriter(row.createdAt);
    const csv: string[] = [bottleCsvHeader()];
    const extension = qr.imageFormat === 'PNG' ? 'png' : 'svg';
    let rows = 0;
    for await (const batch of activeCodeBatches(
      this.prisma,
      lot.id,
      range,
      ZIP_BATCH_SIZE,
    )) {
      for (const unit of batch) {
        csv.push(bottleCsvRow(unit, context));
        const url = context.qrUrl(unit.code);
        const name = `${ZIP_QR_FOLDER}/${unit.serial}-${unit.code}.${extension}`;
        if (qr.imageFormat === 'PNG') {
          // Un PNG ya va comprimido: se guarda tal cual
          zip.add(name, qrPng(url, qr), { store: true });
        } else {
          zip.add(name, Buffer.from(await qrSvg(url, qr), 'utf8'));
        }
        rows += 1;
      }
      // Cede el turno: el worker renueva el candado del trabajo entre tandas
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    zip.add(ZIP_CSV_NAME, Buffer.from(csv.join(''), 'utf8'));
    const bytes = zip.finish();

    const storageKey = bottleExportStorageKey(lot.wineryId, row.id);
    const storage = await this.objectStorage();
    await storage.put(storageKey, bytes, 'application/zip');
    await this.prisma.bottleCodeExport.update({
      where: { id: row.id },
      data: { status: 'READY', storageKey, rows, error: null },
    });
    this.logger.log({
      message: `Exportación ZIP de códigos de botella lista (${rows} códigos, ${bytes.length} bytes)`,
      exportId: row.id,
      lotId: lot.id,
      rows,
      bytes: bytes.length,
    });
    return { status: 'READY', rows, bytes: bytes.length, storageKey };
  }

  /** Deja la exportación `FAILED` con el motivo (último intento del trabajo). */
  async markFailed(exportId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.bottleCodeExport.updateMany({
      where: { id: exportId, status: { not: 'READY' } },
      data: { status: 'FAILED', error: message.slice(0, 2000) },
    });
  }

  /**
   * Borra del almacenamiento los ZIP caducados (7 días, §15). La fila de la
   * exportación se conserva (queda en la bitácora quién exportó y qué rango).
   */
  async removeExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.bottleCodeExport.findMany({
      where: { expiresAt: { lt: now }, storageKey: { not: null } },
      select: { id: true, storageKey: true },
      take: 200,
    });
    if (expired.length === 0) return 0;
    const storage = await this.objectStorage();
    let removed = 0;
    for (const row of expired) {
      await storage.delete(row.storageKey as string);
      await this.prisma.bottleCodeExport.update({
        where: { id: row.id },
        data: { storageKey: null },
      });
      removed += 1;
    }
    return removed;
  }
}
