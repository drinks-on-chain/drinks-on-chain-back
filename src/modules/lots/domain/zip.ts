import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Escritor de archivos ZIP mínimo (APPNOTE 6.3.x, sin ZIP64) para la
 * exportación de códigos de botella a la imprenta (contrato O2 §7.2): un CSV
 * y una imagen de QR por botella. Entradas con nombre UTF-8 (bit 11),
 * comprimidas con DEFLATE o guardadas tal cual (`store`, para PNG).
 *
 * Límites del formato clásico: 65 535 entradas y 4 GiB; por encima se
 * rechaza (la exportación ya limita su rango).
 */
export const ZIP_MAX_ENTRIES = 65_535;
const ZIP_MAX_BYTES = 0xffff_ffff;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION = 20;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    day:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

function assertSafeName(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Nombre de entrada ZIP inválido: ${name}`);
  }
}

export class ZipWriter {
  private readonly parts: Buffer[] = [];
  private readonly central: Buffer[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private finished = false;
  private readonly stamp: { time: number; day: number };

  constructor(modifiedAt: Date = new Date()) {
    this.stamp = dosDateTime(modifiedAt);
  }

  get entries(): number {
    return this.central.length;
  }

  /** Añade un archivo. `store` lo guarda sin comprimir. */
  add(name: string, data: Buffer, options: { store?: boolean } = {}): void {
    if (this.finished) throw new Error('El ZIP ya está cerrado');
    assertSafeName(name);
    if (this.names.has(name)) {
      throw new Error(`Entrada ZIP duplicada: ${name}`);
    }
    if (this.central.length >= ZIP_MAX_ENTRIES) {
      throw new Error(`Un ZIP admite como máximo ${ZIP_MAX_ENTRIES} entradas`);
    }
    this.names.add(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const method = options.store ? METHOD_STORE : METHOD_DEFLATE;
    const body = options.store ? data : deflateRawSync(data, { level: 6 });
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(this.stamp.time, 10);
    local.writeUInt16LE(this.stamp.day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(VERSION, 6);
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(this.stamp.time, 12);
    header.writeUInt16LE(this.stamp.day, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    // extra, comentario, disco, atributos internos y externos: 0
    header.writeUInt32LE(this.offset, 42);

    this.parts.push(local, nameBytes, body);
    this.central.push(Buffer.concat([header, nameBytes]));
    this.offset += local.length + nameBytes.length + body.length;
    if (this.offset > ZIP_MAX_BYTES) {
      throw new Error('El ZIP supera los 4 GiB del formato clásico');
    }
  }

  /** Cierra el archivo y devuelve sus bytes. */
  finish(): Buffer {
    if (this.finished) throw new Error('El ZIP ya está cerrado');
    this.finished = true;
    const directory = Buffer.concat(this.central);
    if (this.offset + directory.length > ZIP_MAX_BYTES) {
      throw new Error('El ZIP supera los 4 GiB del formato clásico');
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, directory, end]);
  }
}
