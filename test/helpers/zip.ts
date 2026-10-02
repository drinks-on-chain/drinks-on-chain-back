import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Lee un ZIP clásico (sin ZIP64) desde su directorio central y devuelve las
 * entradas descomprimidas, comprobando tamaños y CRC-32. Para verificar en
 * las pruebas los ZIP que genera el backend.
 */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) {
    throw new Error('No es un ZIP (falta el fin del directorio central)');
  }
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Directorio central del ZIP dañado');
    }
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const local = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (zip.readUInt32LE(local) !== 0x04034b50) {
      throw new Error(`Cabecera local dañada en ${name}`);
    }
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (data.length !== size || crc32(data) >>> 0 !== checksum) {
      throw new Error(`Tamaño o CRC incorrecto en ${name}`);
    }
    entries.set(name, data);
    cursor += 46 + nameLength;
  }
  return entries;
}
