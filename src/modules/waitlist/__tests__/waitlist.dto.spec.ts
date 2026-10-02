import type { ArgumentMetadata } from '@nestjs/common';
import { createAppValidationPipe } from '@shared/pipes/app-validation.pipe';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import {
  JoinWaitlistDto,
  UpdateWaitlistEntryDto,
  WaitlistListQueryDto,
} from '../dto/waitlist.dto';

const pipe = createAppValidationPipe();
const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
});

const consumer = {
  type: 'CONSUMER',
  fullName: 'Lucía Fernández',
  email: 'lucia@example.com',
  isAdult: true,
  consent: true,
};
const winery = {
  type: 'WINERY',
  fullName: 'Rodrigo Aguilar',
  email: 'rodrigo@altocamargo.test',
  wineryName: 'Viñas del Alto Camargo',
  consent: true,
};

async function join(input: Record<string, unknown>): Promise<JoinWaitlistDto> {
  return (await pipe.transform(
    input,
    body(JoinWaitlistDto),
  )) as JoinWaitlistDto;
}

async function errors(
  input: Record<string, unknown>,
  metatype: ArgumentMetadata['metatype'] = JoinWaitlistDto,
): Promise<ErrorDetail[]> {
  try {
    await pipe.transform(input, body(metatype));
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationException);
    return (error as ValidationException).details as ErrorDetail[];
  }
  throw new Error('Se esperaba un error de validación');
}

const fields = (details: ErrorDetail[]) => [
  ...new Set(details.map((d) => d.field)),
];

describe('Lista de espera · validación de la inscripción (contrato O1b §1)', () => {
  it('consumidor y bodega mínimos son válidos', async () => {
    await expect(join(consumer)).resolves.toMatchObject({ type: 'CONSUMER' });
    await expect(join(winery)).resolves.toMatchObject({
      type: 'WINERY',
      wineryName: 'Viñas del Alto Camargo',
    });
  });

  it('normaliza el correo (minúsculas, sin espacios) y el origen', async () => {
    const dto = await join({
      ...consumer,
      email: '  Lucia.Fernandez@Example.COM ',
      fullName: '  Lucía Fernández ',
      source: ' Tarija-2026 ',
      phone: ' +591 (72) 110-022 ',
      city: '   ',
    });
    expect(dto.email).toBe('lucia.fernandez@example.com');
    expect(dto.fullName).toBe('Lucía Fernández');
    expect(dto.source).toBe('tarija-2026');
    expect(dto.phone).toBe('+591 (72) 110-022');
    expect(dto.city).toBeNull();
  });

  it('`null` en un opcional equivale a omitirlo', async () => {
    const dto = await join({
      ...consumer,
      phone: null,
      interest: null,
      wineryName: null,
      source: null,
      website: null,
      captchaToken: null,
    });
    expect(dto.phone).toBeUndefined();
    expect(dto.source).toBeUndefined();
  });

  it('consumidor: isAdult obligatorio y true → 422 en `isAdult`', async () => {
    for (const isAdult of [undefined, null, false, 'true']) {
      const details = await errors({ ...consumer, isAdult });
      expect(fields(details)).toEqual(['isAdult']);
      expect(details[0].message).toBe('Debes confirmar que eres mayor de edad');
    }
  });

  it('bodega: isAdult opcional, pero booleano si llega', async () => {
    await expect(join({ ...winery, isAdult: false })).resolves.toBeDefined();
    expect(fields(await errors({ ...winery, isAdult: 'sí' }))).toEqual([
      'isAdult',
    ]);
  });

  it('consent distinto de true → 422 en `consent`', async () => {
    for (const consent of [undefined, false, 'true', 1]) {
      expect(fields(await errors({ ...consumer, consent }))).toEqual([
        'consent',
      ]);
    }
  });

  it('bodega sin wineryName → 422 en `wineryName`', async () => {
    for (const wineryName of [undefined, null, '', '   ', 'A']) {
      expect(fields(await errors({ ...winery, wineryName }))).toEqual([
        'wineryName',
      ]);
    }
    // En un consumidor es opcional, pero si llega se valida
    await expect(join({ ...consumer, wineryName: '' })).resolves.toBeDefined();
    expect(fields(await errors({ ...consumer, wineryName: 'A' }))).toEqual([
      'wineryName',
    ]);
  });

  it('correo, nombre, teléfono, origen, idioma, tipo y enumerados inválidos', async () => {
    expect(
      fields(await errors({ ...consumer, email: 'no-es-correo' })),
    ).toEqual(['email']);
    expect(fields(await errors({ ...consumer, email: undefined }))).toEqual([
      'email',
    ]);
    expect(fields(await errors({ ...consumer, fullName: 'L' }))).toEqual([
      'fullName',
    ]);
    expect(
      fields(await errors({ ...consumer, fullName: 'x'.repeat(121) })),
    ).toEqual(['fullName']);
    for (const phone of ['12345', 'abc1234567', '1'.repeat(21)]) {
      expect(fields(await errors({ ...consumer, phone }))).toEqual(['phone']);
    }
    for (const source of ['tarija 2026', 'x'.repeat(41), 'feria_2026']) {
      expect(fields(await errors({ ...consumer, source }))).toEqual(['source']);
    }
    expect(fields(await errors({ ...consumer, locale: 'fr' }))).toEqual([
      'locale',
    ]);
    expect(fields(await errors({ ...consumer, type: 'PARTNER' }))).toContain(
      'type',
    );
    expect(fields(await errors({ ...consumer, interest: 'BEER' }))).toEqual([
      'interest',
    ]);
    expect(fields(await errors({ ...winery, produces: 'BEER' }))).toEqual([
      'produces',
    ]);
    expect(
      fields(await errors({ ...consumer, message: 'x'.repeat(501) })),
    ).toEqual(['message']);
    expect(fields(await errors({ ...consumer, city: 'x'.repeat(81) }))).toEqual(
      ['city'],
    );
    // Campos desconocidos: 422 (lista blanca)
    expect(fields(await errors({ ...consumer, admin: true }))).toEqual([
      'admin',
    ]);
  });

  it('los mensajes están en español', async () => {
    const details = await errors({
      type: 'WINERY',
      fullName: 'R',
      email: 'x',
      consent: false,
    });
    expect(details.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        'El nombre debe tener entre 2 y 120 caracteres',
        'El correo electrónico debe ser válido',
        'El nombre de la bodega es obligatorio',
        'Debes aceptar el aviso de privacidad para inscribirte',
      ]),
    );
  });
});

describe('Lista de espera · back office (contrato O1b §2)', () => {
  it('PATCH: notas de hasta 1000 caracteres; null las borra y vacío también', async () => {
    const patch = (input: Record<string, unknown>) =>
      pipe.transform(input, body(UpdateWaitlistEntryDto));
    await expect(patch({ notes: null })).resolves.toEqual({ notes: null });
    await expect(patch({ notes: '   ' })).resolves.toEqual({ notes: null });
    await expect(patch({ status: 'CONTACTED' })).resolves.toEqual({
      status: 'CONTACTED',
    });
    expect(
      fields(await errors({ notes: 'x'.repeat(1001) }, UpdateWaitlistEntryDto)),
    ).toEqual(['notes']);
    expect(
      fields(await errors({ status: 'DONE' }, UpdateWaitlistEntryDto)),
    ).toEqual(['status']);
  });

  it('lista: filtros y página con sus valores por defecto', async () => {
    const query = (await pipe.transform(
      { type: 'WINERY', source: 'Tarija-2026', from: '2026-10-01', q: ' ana ' },
      { type: 'query', metatype: WaitlistListQueryDto },
    )) as WaitlistListQueryDto;
    expect(query).toMatchObject({
      type: 'WINERY',
      source: 'tarija-2026',
      from: '2026-10-01',
      q: 'ana',
      limit: 20,
      offset: 0,
    });
    await expect(
      pipe.transform(
        { from: 'ayer' },
        { type: 'query', metatype: WaitlistListQueryDto },
      ),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});
