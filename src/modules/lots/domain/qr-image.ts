import { crc32, deflateSync } from 'node:zlib';
import * as QRCode from 'qrcode';

/**
 * Imagen del QR de una botella para la imprenta (contrato O2 §7.2): el QR
 * codifica `{PASSPORT_BASE_URL}/b/{código}` con corrección de errores `M`.
 *
 * - SVG: vectorial (lo que conviene a la imprenta), con `width`/`height` de
 *   `sizePx`.
 * - PNG: 1 bit por píxel (negro sobre blanco), exactamente `sizePx × sizePx`:
 *   los módulos se escalan a un número entero de píxeles y el sobrante se
 *   reparte como margen blanco, así que los bordes de los módulos son nítidos.
 *
 * `margin` es la zona de silencio en módulos (4 es la del estándar).
 */
export interface QrImageOptions {
  sizePx: number;
  margin: number;
}

export const QR_DEFAULT_SIZE_PX = 512;
export const QR_DEFAULT_MARGIN = 4;
const ERROR_CORRECTION = 'M' as const;

export interface QrMatrix {
  /** Módulos por lado (sin margen). */
  size: number;
  isDark(row: number, column: number): boolean;
}

/** Matriz de módulos del QR de `text`. */
export function qrMatrix(text: string): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION });
  const { size, data } = qr.modules;
  return {
    size,
    isDark: (row, column) => data[row * size + column] === 1,
  };
}

/** QR en SVG (texto UTF-8). */
export function qrSvg(text: string, options: QrImageOptions): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: ERROR_CORRECTION,
    margin: options.margin,
    width: options.sizePx,
  });
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

/** QR en PNG de 1 bit (escala de grises: 0 = negro, 1 = blanco). */
export function qrPng(text: string, options: QrImageOptions): Buffer {
  const matrix = qrMatrix(text);
  const modules = matrix.size + 2 * options.margin;
  const scale = Math.floor(options.sizePx / modules);
  if (scale < 1) {
    throw new Error(
      `El QR necesita al menos ${modules} px de lado (sizePx = ${options.sizePx})`,
    );
  }
  const side = options.sizePx;
  // El sobrante de la división entera se reparte como margen adicional
  const offset = Math.floor((side - matrix.size * scale) / 2);
  const rowBytes = Math.ceil(side / 8);
  const white = Buffer.alloc(1 + rowBytes, 0xff);
  white[0] = 0; // filtro 0 (ninguno)
  const raw = Buffer.alloc((1 + rowBytes) * side);
  let lastRow = -1;
  let line = white;
  for (let y = 0; y < side; y++) {
    const row = Math.floor((y - offset) / scale);
    if (y < offset || row >= matrix.size) {
      line = white;
      lastRow = -1;
    } else if (row !== lastRow) {
      line = Buffer.from(white);
      for (let column = 0; column < matrix.size; column++) {
        if (!matrix.isDark(row, column)) continue;
        const from = offset + column * scale;
        for (let x = from; x < from + scale; x++) {
          line[1 + (x >> 3)] &= ~(0x80 >> (x & 7));
        }
      }
      lastRow = row;
    }
    line.copy(raw, y * (1 + rowBytes));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 1; // profundidad: 1 bit
  header[9] = 0; // tipo de color: escala de grises
  // compresión, filtro y entrelazado: 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
