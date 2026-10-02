import { crc32, inflateRawSync, inflateSync } from 'node:zlib';
import {
  bottleCsvHeader,
  bottleCsvRow,
  bottleExportFilename,
  BOTTLE_CSV_HEADER,
} from '../domain/bottle-csv';
import {
  generateBottleCode,
  hasValidCheckChar,
  isValidBottleCode,
  luhnMod32CheckChar,
  normalizeBottleCode,
  CROCKFORD_ALPHABET,
} from '../domain/bottle-code';
import {
  ALCOHOL_BALANCE_TOLERANCE,
  bottlingBalanceViolations,
  computeBottlingBalance,
} from '../domain/bottling-balance';
import { qrMatrix, qrPng, qrSvg } from '../domain/qr-image';
import { ZipWriter } from '../domain/zip';
import { resolveSerialRange } from '../bottle-codes.service';
import { passportUrl, resolvePassportBaseUrl } from '../bottle-units';

/** Lee un ZIP (directorio central) y devuelve sus entradas descomprimidas. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const local = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    expect(crc32(data) >>> 0).toBe(checksum);
    entries.set(name, data);
    cursor += 46 + nameLength;
  }
  return entries;
}

/** Decodifica un PNG de 1 bit sin entrelazar: `true` = píxel negro. */
function readPng(png: Buffer): {
  side: number;
  dark: (x: number, y: number) => boolean;
} {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  let cursor = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (cursor < png.length) {
    const length = png.readUInt32BE(cursor);
    const type = png.toString('ascii', cursor + 4, cursor + 8);
    const body = png.subarray(cursor + 8, cursor + 8 + length);
    expect(png.readUInt32BE(cursor + 8 + length)).toBe(
      crc32(png.subarray(cursor + 4, cursor + 8 + length)) >>> 0,
    );
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[9], body[10], body[11], body[12]]).toEqual([
        1, 0, 0, 0, 0,
      ]);
    } else if (type === 'IDAT') {
      data.push(Buffer.from(body));
    }
    cursor += 12 + length;
  }
  expect(width).toBe(height);
  const raw = inflateSync(Buffer.concat(data));
  const rowBytes = Math.ceil(width / 8);
  expect(raw.length).toBe((1 + rowBytes) * height);
  return {
    side: width,
    dark: (x, y) => {
      const row = y * (1 + rowBytes);
      expect(raw[row]).toBe(0);
      return (raw[row + 1 + (x >> 3)] & (0x80 >> (x & 7))) === 0;
    },
  };
}

describe('dígito de control de los códigos de botella (§7.1)', () => {
  it('detecta la transposición de dos caracteres vecinos distintos (casi todas)', () => {
    let detected = 0;
    let total = 0;
    for (let n = 0; n < 200; n++) {
      const code = generateBottleCode();
      for (let i = 0; i < code.length - 1; i++) {
        if (code[i] === code[i + 1]) continue;
        const swapped =
          code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
        total += 1;
        if (!hasValidCheckChar(swapped)) detected += 1;
      }
    }
    expect(detected / total).toBeGreaterThan(0.9);
  });

  it('el control es determinista y queda dentro del alfabeto', () => {
    expect(luhnMod32CheckChar('K7M2Q9X')).toBe(luhnMod32CheckChar('K7M2Q9X'));
    for (const payload of ['0000000', 'ZZZZZZZ', 'K7M2Q9X', 'ABCDEFG']) {
      const check = luhnMod32CheckChar(payload);
      expect(CROCKFORD_ALPHABET).toContain(check);
      expect(isValidBottleCode(payload + check)).toBe(true);
    }
  });

  it('acepta lo que se teclea con guion y minúsculas, y rechaza formas imposibles', () => {
    const code = generateBottleCode();
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(normalizeBottleCode(typed)).toBe(code);
    expect(isValidBottleCode(normalizeBottleCode(typed))).toBe(true);
    expect(isValidBottleCode('K7M2Q9X')).toBe(false);
    expect(isValidBottleCode('K7M2Q9XAA')).toBe(false);
    expect(isValidBottleCode('K7M2Q9XU')).toBe(false);
  });
});

describe('balance de alcohol con tolerancia de medida (S-11)', () => {
  const base = {
    productType: 'SINGANI' as const,
    availableLiters: 1500,
    waterDilutionLiters: 800,
    formatCl: 75,
    leftoverLiters: 0,
    maxLossPercent: 5,
    finalAbv: 40,
    pureAlcoholAvailableLiters: 900,
  };
  const codes = (bottles: number) => {
    const input = { ...base, bottles };
    return bottlingBalanceViolations(input, computeBottlingBalance(input)).map(
      (v) => v.code,
    );
  };

  it('la tolerancia es del 0,5 %', () => {
    expect(ALCOHOL_BALANCE_TOLERANCE).toBe(0.005);
  });

  it('hasta el 0,5 % por encima del alcohol del corazón pasa; más, no', () => {
    // 900 L × 1,005 = 904,5 L de alcohol puro → 3.015 botellas de 75 cL al 40 %
    expect(codes(3015)).toEqual([]);
    expect(codes(3013)).toEqual([]);
    expect(codes(3016)).toContain('TRC_ALCOHOL_BALANCE_EXCEEDED');
  });
});

describe('URL del pasaporte (§6.3, OP-06)', () => {
  it('usa PASSPORT_BASE_URL, si no la del Marketplace y si no la local', () => {
    expect(
      resolvePassportBaseUrl({
        PASSPORT_BASE_URL: 'https://app.drinksonchain.com/',
        APP_URL_MARKETPLACE: 'https://otra.test',
      }),
    ).toBe('https://app.drinksonchain.com/');
    expect(
      resolvePassportBaseUrl({
        PASSPORT_BASE_URL: ' ',
        APP_URL_MARKETPLACE: 'https://mercado.test',
      }),
    ).toBe('https://mercado.test');
    expect(resolvePassportBaseUrl({})).toBe('http://localhost:3005');
  });

  it('arma {base}/b/{código} sin barras dobles', () => {
    expect(passportUrl('https://app.drinksonchain.com/', 'K7M2Q9XA')).toBe(
      'https://app.drinksonchain.com/b/K7M2Q9XA',
    );
    expect(passportUrl('https://app.test', 'CVJ-2026-SINGANI-004')).toBe(
      'https://app.test/b/CVJ-2026-SINGANI-004',
    );
  });
});

describe('rango de series de una exportación (§7.2)', () => {
  it('por defecto 1…N y respeta el rango pedido', () => {
    expect(resolveSerialRange(2950, undefined, undefined)).toEqual({
      fromSerial: 1,
      toSerial: 2950,
    });
    expect(resolveSerialRange(2950, 100, 200)).toEqual({
      fromSerial: 100,
      toSerial: 200,
    });
    expect(resolveSerialRange(2950, 2950, undefined)).toEqual({
      fromSerial: 2950,
      toSerial: 2950,
    });
  });

  it('fromSerial > toSerial o fuera de 1…N → VALIDATION_ERROR', () => {
    for (const [from, to] of [
      [200, 100],
      [1, 2951],
      [2951, undefined],
      [0, 10],
    ] as const) {
      expect(() => resolveSerialRange(2950, from, to)).toThrow(
        expect.objectContaining({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
        }),
      );
    }
  });
});

describe('CSV de códigos de botella (§7.2)', () => {
  const context = {
    lotCode: 'CVJ-2026-SINGANI-004',
    lotName: 'Singani "Gran Reserva", 2026',
    productType: 'SINGANI',
    bottlingDate: '2026-10-01',
    qrUrl: (code: string) => passportUrl('https://app.drinksonchain.com', code),
  };

  it('cabecera del contrato, con BOM y CRLF', () => {
    expect(BOTTLE_CSV_HEADER).toBe(
      'serial,code,codeFormatted,qrUrl,lotCode,lotName,productType,bottlingDate',
    );
    expect(bottleCsvHeader()).toBe(
      String.fromCharCode(0xfeff) + BOTTLE_CSV_HEADER + '\r\n',
    );
  });

  it('una fila por código, con el código formateado y la URL del QR', () => {
    expect(bottleCsvRow({ serial: 1234, code: 'K7M2Q9XA' }, context)).toBe(
      '1234,K7M2Q9XA,K7M2-Q9XA,https://app.drinksonchain.com/b/K7M2Q9XA,' +
        'CVJ-2026-SINGANI-004,"Singani ""Gran Reserva"", 2026",SINGANI,2026-10-01\r\n',
    );
  });

  it('neutraliza un nombre de lote que empieza como una fórmula', () => {
    const row = bottleCsvRow(
      { serial: 1, code: 'K7M2Q9XA' },
      { ...context, lotName: '=HYPERLINK("http://malo")' },
    );
    expect(row).toContain(`"'=HYPERLINK(""http://malo"")"`);
  });

  it('nombre del archivo con el lote y el rango', () => {
    expect(
      bottleExportFilename(
        'CVJ-2026-SINGANI-004',
        { fromSerial: 1, toSerial: 2950 },
        'csv',
      ),
    ).toBe('codigos-CVJ-2026-SINGANI-004-1-2950.csv');
    expect(
      bottleExportFilename('A/B "C"', { fromSerial: 5, toSerial: 9 }, 'zip'),
    ).toBe('codigos-A-B-C-5-9.zip');
  });
});

describe('ZIP para la imprenta (§7.2)', () => {
  it('guarda cada entrada con su CRC, comprimida o tal cual, y nombres UTF-8', () => {
    const zip = new ZipWriter(new Date('2026-10-01T12:34:56Z'));
    const csv = Buffer.from(
      'serial,code\r\n1,K7M2Q9XA\r\n'.repeat(200),
      'utf8',
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    zip.add('codigos.csv', csv);
    zip.add('qr/1-K7M2Q9XA.png', png, { store: true });
    zip.add('qr/añada-ñ.svg', Buffer.from('<svg/>', 'utf8'));
    zip.add('vacío.txt', Buffer.alloc(0));
    expect(zip.entries).toBe(4);
    const bytes = zip.finish();
    const entries = readZip(bytes);
    expect([...entries.keys()]).toEqual([
      'codigos.csv',
      'qr/1-K7M2Q9XA.png',
      'qr/añada-ñ.svg',
      'vacío.txt',
    ]);
    expect(entries.get('codigos.csv')?.equals(csv)).toBe(true);
    expect(entries.get('qr/1-K7M2Q9XA.png')?.equals(png)).toBe(true);
    expect(entries.get('vacío.txt')?.length).toBe(0);
    // El CSV repetitivo se comprime
    expect(bytes.length).toBeLessThan(csv.length);
  });

  it('rechaza nombres peligrosos o repetidos y no admite añadir tras cerrar', () => {
    const zip = new ZipWriter();
    for (const name of [
      '../fuera.txt',
      '/abs.txt',
      'a//b',
      'a\\b',
      '',
      'a/./b',
    ]) {
      expect(() => zip.add(name, Buffer.from('x'))).toThrow(/inválido/);
    }
    zip.add('a.txt', Buffer.from('x'));
    expect(() => zip.add('a.txt', Buffer.from('y'))).toThrow(/duplicada/);
    zip.finish();
    expect(() => zip.add('b.txt', Buffer.from('x'))).toThrow(/cerrado/);
    expect(() => zip.finish()).toThrow(/cerrado/);
  });

  it('5.000 QR en SVG caben en un ZIP', async () => {
    const zip = new ZipWriter();
    for (let serial = 1; serial <= 5000; serial++) {
      const code = generateBottleCode();
      const svg =
        serial <= 50
          ? await qrSvg(`https://app.drinksonchain.com/b/${code}`, {
              sizePx: 512,
              margin: 4,
            })
          : `<svg>${code}</svg>`;
      zip.add(`qr/${serial}-${code}.svg`, Buffer.from(svg, 'utf8'));
    }
    const entries = readZip(zip.finish());
    expect(entries.size).toBe(5000);
  }, 60_000);
});

describe('imagen del QR (§7.2)', () => {
  const url = 'https://app.drinksonchain.com/b/K7M2Q9XA';

  it('SVG con el tamaño pedido', async () => {
    const svg = await qrSvg(url, { sizePx: 512, margin: 4 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="512"');
    expect(svg).toContain('height="512"');
  });

  it('PNG de 1 bit, del tamaño exacto, que reproduce los módulos del QR', () => {
    const matrix = qrMatrix(url);
    for (const options of [
      { sizePx: 512, margin: 4 },
      { sizePx: 300, margin: 0 },
      { sizePx: 64, margin: 2 },
    ]) {
      const png = readPng(qrPng(url, options));
      expect(png.side).toBe(options.sizePx);
      const scale = Math.floor(
        options.sizePx / (matrix.size + 2 * options.margin),
      );
      const offset = Math.floor((options.sizePx - matrix.size * scale) / 2);
      for (let row = 0; row < matrix.size; row++) {
        for (let column = 0; column < matrix.size; column++) {
          // Centro y esquinas de cada módulo
          for (const [dx, dy] of [
            [0, 0],
            [scale - 1, scale - 1],
            [scale >> 1, scale >> 1],
          ]) {
            expect(
              png.dark(offset + column * scale + dx, offset + row * scale + dy),
            ).toBe(matrix.isDark(row, column));
          }
        }
      }
      // Zona de silencio blanca alrededor
      expect(png.dark(0, 0)).toBe(false);
      expect(png.dark(options.sizePx - 1, options.sizePx - 1)).toBe(false);
      if (offset > 0) {
        expect(png.dark(offset - 1, offset)).toBe(false);
        expect(png.dark(offset, offset - 1)).toBe(false);
      }
    }
  });

  it('un tamaño menor que el QR con su margen se rechaza', () => {
    expect(() => qrPng(url, { sizePx: 20, margin: 4 })).toThrow(/al menos/);
  });

  it('el PNG de 1 bit es compacto (menos de 1 KB a 512 px)', () => {
    let bytes = 0;
    for (let i = 0; i < 200; i++) {
      bytes += qrPng(`${url}${i}`, { sizePx: 512, margin: 4 }).length;
    }
    expect(bytes / 200).toBeLessThan(1024);
  }, 60_000);
});
