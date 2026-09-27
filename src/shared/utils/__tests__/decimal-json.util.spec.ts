import { Readable } from 'stream';
import { StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decimalsToNumbers, isDecimal } from '../decimal-json.util';

const D = (v: string | number) => new Prisma.Decimal(v);
// Otro constructor de decimal.js (como el de una librería que lo empaquete aparte)
const OtherDecimal = Prisma.Decimal.clone();

describe('decimalsToNumbers', () => {
  it('convierte Prisma.Decimal y decimal.js en números JSON', () => {
    expect(decimalsToNumbers(D('5'))).toBe(5);
    expect(decimalsToNumbers(D('12100.125'))).toBe(12100.125);
    expect(decimalsToNumbers(D('-21.48512000'))).toBe(-21.48512);
    expect(decimalsToNumbers(new OtherDecimal('0.02'))).toBe(0.02);
    expect(isDecimal(new OtherDecimal(1))).toBe(true);
    expect(isDecimal({ d: 1 })).toBe(false);
  });

  it('un decimal no finito sale como null', () => {
    expect(decimalsToNumbers(D(NaN))).toBeNull();
    expect(decimalsToNumbers(D(Infinity))).toBeNull();
  });

  it('recorre objetos anidados y listas, y respeta Date, null y los escalares', () => {
    const createdAt = new Date('2026-09-27T12:00:00.000Z');
    const input = {
      id: 't1',
      surfaceHectares: D('5'),
      latitude: null,
      notes: undefined,
      isActive: true,
      createdAt,
      harvests: [
        { grossWeightKg: D('1200.500'), tags: ['a', 1, null] },
        { grossWeightKg: D('800') },
      ],
      nested: { deeper: { capacityLiters: D('15000.000') } },
    };
    const out = decimalsToNumbers(input);
    expect(out).toEqual({
      id: 't1',
      surfaceHectares: 5,
      latitude: null,
      notes: undefined,
      isActive: true,
      createdAt,
      harvests: [
        { grossWeightKg: 1200.5, tags: ['a', 1, null] },
        { grossWeightKg: 800 },
      ],
      nested: { deeper: { capacityLiters: 15000 } },
    });
    expect(out.createdAt).toBe(createdAt);
    expect(JSON.parse(JSON.stringify(out))).toMatchObject({
      surfaceHectares: 5,
      createdAt: '2026-09-27T12:00:00.000Z',
    });
  });

  it('no modifica la entrada y reutiliza lo que no cambia', () => {
    const untouched = { name: 'sin decimales', list: [1, 2] };
    const input = { a: D('1.5'), untouched };
    const out = decimalsToNumbers(input);
    expect(input.a).toBeInstanceOf(Prisma.Decimal);
    expect(out).not.toBe(input);
    expect(out.untouched).toBe(untouched);

    const plain = { a: 1, b: [{ c: 'x' }] };
    expect(decimalsToNumbers(plain)).toBe(plain);
  });

  it('no toca Buffer, flujos ni instancias de clase', () => {
    const buffer = Buffer.from('hola');
    const file = new StreamableFile(Readable.from(['x']));
    class Holder {
      value = D('1');
    }
    const holder = new Holder();
    const out = decimalsToNumbers({ buffer, file, holder, bytes: [buffer] });
    expect(out.buffer).toBe(buffer);
    expect(out.file).toBe(file);
    expect(out.holder).toBe(holder);
    expect(out.holder.value).toBeInstanceOf(Prisma.Decimal);
    expect(out.bytes[0]).toBe(buffer);
  });

  it('tolera referencias compartidas y ciclos', () => {
    const shared = { v: D('2.5') };
    const out = decimalsToNumbers({ a: shared, b: shared });
    expect(out.a).toEqual({ v: 2.5 });
    expect(out.b).toBe(out.a);

    const cyclic: Record<string, unknown> = { v: D('1') };
    cyclic.self = cyclic;
    const converted = decimalsToNumbers(cyclic);
    expect(converted.v).toBe(1);
  });

  it('objetos sin prototipo también se recorren', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.x = D('3');
    expect(decimalsToNumbers(bare)).toEqual({ x: 3 });
  });
});
