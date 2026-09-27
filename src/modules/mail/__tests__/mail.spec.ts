import { EmailStatusEnum } from '@prisma/client';
import { MailRenderer } from '../mail.renderer';
import { MailService } from '../mail.service';
import { EmailRequestedHandler } from '../jobs/email-requested.handler';
import type { MailTransport } from '../mail.transport';
import type { PrismaService } from '@shared/prisma/prisma.service';
import type { OutboxService } from '@shared/outbox/outbox.service';

describe('MailRenderer', () => {
  const renderer = new MailRenderer();

  it('renderiza asunto, texto y HTML con la marca', () => {
    const mail = renderer.render('prueba', {
      nombre: 'Ana',
      entorno: 'desarrollo',
    });
    expect(mail.subject).toBe(
      'Correo de prueba de Drinks on Chain (desarrollo)',
    );
    expect(mail.text).toContain('Hola, Ana:');
    expect(mail.text).toContain('Drinks on Chain');
    expect(mail.html).toContain('<html lang="es">');
    expect(mail.html).toContain('#fdfcf5');
    expect(mail.html).toContain('Hola, Ana:');
  });

  it('escapa el HTML de las variables (no en el texto plano)', () => {
    const mail = renderer.render('prueba', {
      nombre: '<script>alert(1)</script> & co',
      entorno: 'x',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.text).toContain('<script>alert(1)</script> & co');
  });

  it('el asunto no admite saltos de línea (inyección de cabeceras)', () => {
    const mail = renderer.render('prueba', {
      nombre: 'Ana',
      entorno: 'dev\r\nBcc: x@evil.test',
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('faltan variables, variables no simples o plantilla desconocida → error', () => {
    expect(() => renderer.render('prueba', { nombre: 'Ana' })).toThrow(
      /entorno/,
    );
    expect(() =>
      renderer.render('prueba', {
        nombre: { toString: 'x' } as unknown as string,
        entorno: 'x',
      }),
    ).toThrow(/valor simple/);
    expect(() => renderer.render('no-existe', {})).toThrow(/desconocida/);
  });
});

describe('MailService.enqueue', () => {
  function setup() {
    const tx = {
      emailMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'mail-1',
            ...data,
          }),
        ),
      },
    };
    const outbox = { add: jest.fn().mockResolvedValue({}) };
    const service = new MailService(
      {} as PrismaService,
      outbox as unknown as OutboxService,
    );
    return { tx, outbox, service };
  }

  it('crea el correo y su evento email.requested en la cola email', async () => {
    const { tx, outbox, service } = setup();
    const message = await service.enqueue(tx as never, {
      template: 'prueba',
      to: ' Ana@Test.BO ',
      variables: { nombre: 'Ana', entorno: 'test' },
    });
    expect(message).toMatchObject({ id: 'mail-1', toAddress: 'ana@test.bo' });
    expect(outbox.add).toHaveBeenCalledWith(tx, {
      type: 'email.requested',
      aggregateType: 'email_message',
      aggregateId: 'mail-1',
      queue: 'email',
      payload: { emailMessageId: 'mail-1' },
    });
  });

  it('con la misma clave de idempotencia devuelve el correo existente', async () => {
    const { tx, outbox, service } = setup();
    tx.emailMessage.findUnique.mockResolvedValue({ id: 'mail-0' });
    await expect(
      service.enqueue(tx as never, {
        template: 'prueba',
        to: 'a@b.bo',
        variables: { nombre: 'A', entorno: 'x' },
        idempotencyKey: 'test:1',
      }),
    ).resolves.toEqual({ id: 'mail-0' });
    expect(tx.emailMessage.create).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('rechaza direcciones inválidas y variables incompletas antes de escribir', async () => {
    const { tx, service } = setup();
    await expect(
      service.enqueue(tx as never, {
        template: 'prueba',
        to: 'no-es-un-correo',
        variables: { nombre: 'A', entorno: 'x' },
      }),
    ).rejects.toThrow(/inválida/);
    await expect(
      service.enqueue(tx as never, {
        template: 'prueba',
        to: 'a@b.bo',
        variables: { nombre: 'A' },
      }),
    ).rejects.toThrow(/entorno/);
    expect(tx.emailMessage.create).not.toHaveBeenCalled();
  });
});

describe('EmailRequestedHandler', () => {
  const data = {
    outboxEventId: 'evt-1',
    eventType: 'email.requested',
    aggregateType: 'email_message',
    aggregateId: 'mail-1',
    payload: { emailMessageId: 'mail-1' },
    correlationId: null,
    occurredAt: new Date().toISOString(),
  };

  function setup(claimed = 1) {
    const prisma = {
      emailMessage: {
        updateMany: jest.fn().mockResolvedValue({ count: claimed }),
        findUnique: jest.fn().mockResolvedValue({ status: 'SENT' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'mail-1',
          template: 'prueba',
          toAddress: 'ana@test.bo',
          variables: { nombre: 'Ana', entorno: 'test' },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const transport: jest.Mocked<MailTransport> = {
      send: jest.fn().mockResolvedValue({ messageId: '<mail-1@x>' }),
      verify: jest.fn(),
      close: jest.fn(),
    };
    const handler = new EmailRequestedHandler(
      prisma as unknown as PrismaService,
      transport,
    );
    return { prisma, transport, handler };
  }

  it('envía con Message-ID estable, marca SENT y borra las variables', async () => {
    const { prisma, transport, handler } = setup();
    await handler.handle(data);
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@test.bo',
        subject: 'Correo de prueba de Drinks on Chain (test)',
        messageId: '<mail-1@mail.drinksonchain.local>',
      }),
    );
    expect(prisma.emailMessage.update).toHaveBeenCalledWith({
      where: { id: 'mail-1' },
      data: expect.objectContaining({
        status: EmailStatusEnum.SENT,
        providerMessageId: '<mail-1@x>',
      }),
    });
    const update = prisma.emailMessage.update.mock.calls[0][0] as {
      data: { variables: unknown };
    };
    expect(update.data.variables).toBeDefined();
  });

  it('no reenvía un correo ya enviado o en curso', async () => {
    const { transport, handler } = setup(0);
    await handler.handle(data);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('si el SMTP falla, marca FAILED con el error y relanza (reintento)', async () => {
    const { prisma, transport, handler } = setup();
    transport.send.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(handler.handle(data)).rejects.toThrow('ECONNREFUSED');
    expect(prisma.emailMessage.update).toHaveBeenCalledWith({
      where: { id: 'mail-1' },
      data: { status: EmailStatusEnum.FAILED, lastError: 'ECONNREFUSED' },
    });
  });
});
