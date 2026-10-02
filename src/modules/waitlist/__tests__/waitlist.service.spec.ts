import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { CaptchaService } from '@shared/captcha/captcha.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { createAuditServiceMock } from '@shared/audit/__tests__/audit-service.mock';
import type { JoinWaitlistDto } from '../dto/waitlist.dto';
import type { WaitlistRateLimiter } from '../waitlist-rate-limiter';
import { WAITLIST_STATS_TTL_MS, WaitlistService } from '../waitlist.service';

const NOW = new Date('2026-10-01T15:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'CONSUMER',
    position: 7,
    status: 'NEW',
    fullName: 'Lucía Fernández',
    email: 'lucia@example.com',
    phone: null,
    city: null,
    interest: null,
    wineryName: null,
    region: null,
    produces: null,
    message: null,
    isAdult: true,
    locale: 'es',
    source: 'tarija-2026',
    consentAt: NOW,
    ip: '203.0.113.9',
    userAgent: 'jest',
    contactedAt: null,
    contactedByUserId: null,
    contactedByName: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function setup(
  options: { existing?: ReturnType<typeof row> | null; last?: number } = {},
) {
  const prisma = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ last_position: options.last ?? 41 }]),
    $transaction: jest.fn(),
    waitlistCounter: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ lastPosition: options.last ?? 41 }),
      update: jest.fn().mockResolvedValue({}),
    },
    waitlistEntry: {
      findUnique: jest.fn().mockResolvedValue(options.existing ?? null),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(row(data)),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(row({ ...(options.existing ?? {}), ...data })),
      ),
      groupBy: jest.fn().mockResolvedValue([
        { type: 'CONSUMER', _count: { _all: 40 } },
        { type: 'WINERY', _count: { _all: 6 } },
      ]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ fullName: 'Valeria Méndez' }),
    },
  };
  prisma.$transaction.mockImplementation(
    (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
  );
  const audit = createAuditServiceMock(prisma);
  const captcha = { verify: jest.fn().mockResolvedValue(undefined) };
  const limiter = {
    checkIp: jest.fn().mockResolvedValue(undefined),
    checkEmail: jest.fn().mockResolvedValue(undefined),
  };
  const service = new WaitlistService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    captcha as unknown as CaptchaService,
    limiter as unknown as WaitlistRateLimiter,
  );
  return { prisma, audit, captcha, limiter, service };
}

const client = { ip: '203.0.113.9', userAgent: 'jest' };
const dto = (overrides: Partial<JoinWaitlistDto> = {}): JoinWaitlistDto =>
  ({
    type: 'CONSUMER',
    fullName: 'Lucía Fernández',
    email: 'lucia@example.com',
    isAdult: true,
    consent: true,
    source: 'tarija-2026',
    ...overrides,
  }) as JoinWaitlistDto;

describe('WaitlistService · inscripción pública', () => {
  const previous = process.env.WAITLIST_CAPTCHA_REQUIRED;
  afterEach(() => {
    if (previous === undefined) delete process.env.WAITLIST_CAPTCHA_REQUIRED;
    else process.env.WAITLIST_CAPTCHA_REQUIRED = previous;
  });

  it('alta nueva: siguiente posición del tipo, datos guardados y bitácora sin datos personales', async () => {
    const { service, prisma, audit, limiter, captcha } = setup({ last: 41 });
    const result = await service.join(
      dto({ phone: '+591 72110022', city: 'Tarija', interest: 'BOTH' }),
      { ip: '203.0.113.9', userAgent: 'x'.repeat(500) },
    );
    expect(result).toEqual({ type: 'CONSUMER', position: 42 });
    expect(limiter.checkIp).toHaveBeenCalledWith('203.0.113.9');
    expect(limiter.checkEmail).toHaveBeenCalledWith('lucia@example.com');
    expect(captcha.verify).not.toHaveBeenCalled();
    expect(prisma.waitlistCounter.update).toHaveBeenCalledWith({
      where: { type: 'CONSUMER' },
      data: { lastPosition: 42 },
    });
    const created = prisma.waitlistEntry.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      type: 'CONSUMER',
      position: 42,
      email: 'lucia@example.com',
      phone: '+591 72110022',
      city: 'Tarija',
      interest: 'BOTH',
      wineryName: null,
      isAdult: true,
      locale: 'es',
      source: 'tarija-2026',
      ip: '203.0.113.9',
    });
    expect(created.consentAt).toBeInstanceOf(Date);
    expect((created.userAgent as string).length).toBe(300);
    expect(audit.recorded).toEqual([
      {
        action: 'WAITLIST_JOINED',
        resource: { type: 'waitlist_entry', id: expect.any(String) },
        organizationId: null,
        after: { type: 'CONSUMER', source: 'tarija-2026' },
        source: { app: 'PUBLIC' },
      },
    ]);
  });

  it('correo ya inscrito: misma respuesta con su posición, sin duplicar ni pisar datos', async () => {
    const existing = row({ position: 7, phone: '70000000', city: null });
    const { service, prisma, audit } = setup({ existing, last: 41 });
    const result = await service.join(
      dto({
        fullName: 'Otro Nombre',
        phone: '+591 79999999',
        city: 'Sucre',
        region: 'Cinti',
      }),
      client,
    );
    expect(result).toEqual({ type: 'CONSUMER', position: 7 });
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
    expect(prisma.waitlistCounter.update).not.toHaveBeenCalled();
    // Solo se completan los vacíos (el teléfono ya estaba)
    expect(prisma.waitlistEntry.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { city: 'Sucre', region: 'Cinti' },
    });
    expect(audit.recorded).toEqual([]);
  });

  it('correo ya inscrito sin nada que completar: no escribe', async () => {
    const existing = row({ phone: '70000000', city: 'Tarija', region: 'x' });
    const { service, prisma } = setup({ existing });
    await service.join(dto({ phone: '71111111', city: 'Sucre' }), client);
    expect(prisma.waitlistEntry.update).not.toHaveBeenCalled();
  });

  it('campo trampa relleno: 201 verosímil (total + 1) sin guardar nada', async () => {
    const { service, prisma, audit, limiter } = setup({ last: 41 });
    const result = await service.join(dto({ website: 'http://spam' }), client);
    expect(result).toEqual({ type: 'CONSUMER', position: 42 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
    expect(limiter.checkEmail).not.toHaveBeenCalled();
    expect(audit.recorded).toEqual([]);
  });

  it('el captcha solo se comprueba con WAITLIST_CAPTCHA_REQUIRED=true', async () => {
    process.env.WAITLIST_CAPTCHA_REQUIRED = 'true';
    const { service, captcha, prisma } = setup();
    await service.join(dto({ captchaToken: 'token' }), client);
    expect(captcha.verify).toHaveBeenCalledWith('token', '203.0.113.9');

    captcha.verify.mockRejectedValueOnce(new Error('CAPTCHA_INVALID'));
    prisma.waitlistEntry.create.mockClear();
    await expect(service.join(dto(), client)).rejects.toThrow(
      'CAPTCHA_INVALID',
    );
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('el límite por IP corta antes de todo; el del correo, antes de guardar', async () => {
    const { service, limiter, prisma, captcha } = setup();
    limiter.checkIp.mockRejectedValueOnce(new Error('429 ip'));
    await expect(service.join(dto(), client)).rejects.toThrow('429 ip');
    expect(captcha.verify).not.toHaveBeenCalled();
    limiter.checkEmail.mockRejectedValueOnce(new Error('429 correo'));
    await expect(service.join(dto(), client)).rejects.toThrow('429 correo');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('totales con caché de 60 s que se vacía con cada alta', async () => {
    const { service, prisma } = setup();
    const t0 = 1_000_000;
    await expect(service.stats(t0)).resolves.toEqual({
      consumers: 40,
      wineries: 6,
    });
    await service.stats(t0 + WAITLIST_STATS_TTL_MS - 1);
    expect(prisma.waitlistEntry.groupBy).toHaveBeenCalledTimes(1);
    await service.stats(t0 + WAITLIST_STATS_TTL_MS);
    expect(prisma.waitlistEntry.groupBy).toHaveBeenCalledTimes(2);
    await service.join(dto(), client);
    await service.stats(t0 + WAITLIST_STATS_TTL_MS + 1);
    expect(prisma.waitlistEntry.groupBy).toHaveBeenCalledTimes(3);
  });
});

describe('WaitlistService · back office', () => {
  const principal = {
    id: '00000000-0000-4000-8000-0000000000aa',
  } as AuthenticatedUser;

  it('filtros → where de Prisma', () => {
    const { service } = setup();
    expect(service.where({})).toEqual({});
    expect(
      service.where({
        type: 'WINERY',
        status: 'NEW',
        source: 'tarija-2026',
        from: '2026-10-01',
        to: '2026-10-02',
        q: 'camargo',
      }),
    ).toEqual({
      type: 'WINERY',
      status: 'NEW',
      source: 'tarija-2026',
      createdAt: {
        gte: new Date('2026-10-01T00:00:00.000Z'),
        lte: new Date('2026-10-02T23:59:59.999Z'),
      },
      OR: [
        { fullName: { contains: 'camargo', mode: 'insensitive' } },
        { email: { contains: 'camargo', mode: 'insensitive' } },
        { wineryName: { contains: 'camargo', mode: 'insensitive' } },
        { phone: { contains: 'camargo' } },
      ],
    });
  });

  it('lista: más reciente primero, sin IP ni agente de usuario', async () => {
    const { service, prisma } = setup();
    prisma.waitlistEntry.findMany.mockResolvedValue([row()]);
    prisma.waitlistEntry.count.mockResolvedValue(1);
    const page = await service.list({ limit: 20, offset: 0 });
    expect(prisma.waitlistEntry.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 20,
      skip: 0,
    });
    expect(page).toMatchObject({ total: 1, limit: 20, offset: 0 });
    expect(page.items[0]).toMatchObject({
      position: 7,
      consentAt: NOW.toISOString(),
      contactedBy: null,
    });
    expect(page.items[0]).not.toHaveProperty('ip');
    expect(page.items[0]).not.toHaveProperty('userAgent');
    expect(page.items[0]).not.toHaveProperty('isAdult');
  });

  it('orígenes: del más numeroso al menos, con el nulo', async () => {
    const { service, prisma } = setup();
    prisma.waitlistEntry.groupBy.mockResolvedValue([
      { source: null, _count: { _all: 2 } },
      { source: 'tarija-2026', _count: { _all: 9 } },
      { source: 'feria', _count: { _all: 2 } },
    ]);
    await expect(service.sources('CONSUMER')).resolves.toEqual([
      { source: 'tarija-2026', count: 9 },
      { source: null, count: 2 },
      { source: 'feria', count: 2 },
    ]);
    expect(prisma.waitlistEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: 'CONSUMER' } }),
    );
  });

  it('pasar a CONTACTED guarda cuándo y quién, con bitácora', async () => {
    const { service, prisma, audit } = setup({ existing: row() });
    const result = await service.update(
      row().id,
      { status: 'CONTACTED', notes: 'Escribirle por WhatsApp' },
      principal,
    );
    const data = prisma.waitlistEntry.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: 'CONTACTED',
      notes: 'Escribirle por WhatsApp',
      contactedByUserId: principal.id,
      contactedByName: 'Valeria Méndez',
    });
    expect(data.contactedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({
      status: 'CONTACTED',
      contactedBy: 'Valeria Méndez',
      notes: 'Escribirle por WhatsApp',
    });
    expect(audit.recorded).toEqual([
      {
        action: 'WAITLIST_STATUS_CHANGED',
        resource: { type: 'waitlist_entry', id: row().id },
        organizationId: null,
        before: { status: 'NEW' },
        after: { status: 'CONTACTED', notesChanged: true },
      },
    ]);
  });

  it('volver a NEW borra el contacto; DISCARDED lo conserva', async () => {
    const contacted = row({
      status: 'CONTACTED',
      contactedAt: NOW,
      contactedByUserId: principal.id,
      contactedByName: 'Valeria Méndez',
    });
    const first = setup({ existing: contacted });
    await first.service.update(contacted.id, { status: 'NEW' }, principal);
    expect(first.prisma.waitlistEntry.update.mock.calls[0][0].data).toEqual({
      status: 'NEW',
      contactedAt: null,
      contactedByUserId: null,
      contactedByName: null,
    });
    const second = setup({ existing: contacted });
    await second.service.update(
      contacted.id,
      { status: 'DISCARDED' },
      principal,
    );
    expect(second.prisma.waitlistEntry.update.mock.calls[0][0].data).toEqual({
      status: 'DISCARDED',
    });
  });

  it('sin cambios no escribe ni deja bitácora; solo notas → notesChanged', async () => {
    const { service, prisma, audit } = setup({
      existing: row({ notes: 'Hola' }),
    });
    await service.update(row().id, { status: 'NEW', notes: 'Hola' }, principal);
    await service.update(row().id, {}, principal);
    expect(prisma.waitlistEntry.update).not.toHaveBeenCalled();
    expect(audit.recorded).toEqual([]);

    await service.update(row().id, { notes: null }, principal);
    expect(prisma.waitlistEntry.update.mock.calls[0][0].data).toEqual({
      notes: null,
    });
    expect(audit.recorded[0]).toMatchObject({
      before: { status: 'NEW' },
      after: { status: 'NEW', notesChanged: true },
    });
  });

  it('inscripción inexistente → 404', async () => {
    const { service } = setup({ existing: null });
    await expect(
      service.update(row().id, { status: 'CONTACTED' }, principal),
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'NOT_FOUND' });
  });

  it('exportación: lotes por cursor y bitácora con filas y filtros (sin el texto buscado)', async () => {
    const { service, prisma, audit } = setup();
    const a = row({ id: 'a' });
    const b = row({ id: 'b' });
    const c = row({ id: 'c' });
    prisma.waitlistEntry.findMany
      .mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([c]);
    const ids: string[] = [];
    for await (const batch of service.batches({}, 2)) {
      ids.push(...batch.map((e) => e.id));
    }
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(prisma.waitlistEntry.findMany).toHaveBeenNthCalledWith(2, {
      where: {},
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 2,
      cursor: { id: 'b' },
      skip: 1,
    });

    await service.recordExport(3, { type: 'CONSUMER', q: 'lucia@example.com' });
    expect(audit.recorded).toEqual([
      {
        action: 'WAITLIST_EXPORTED',
        resource: { type: 'waitlist_entry', id: null },
        organizationId: null,
        after: {
          rows: 3,
          filters: {
            type: 'CONSUMER',
            status: null,
            source: null,
            from: null,
            to: null,
            searched: true,
          },
        },
      },
    ]);
  });
});
