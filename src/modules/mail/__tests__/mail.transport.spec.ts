import * as Joi from 'joi';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  MailSettings,
  MailTransport,
  RoutingMailTransport,
  SmtpServerSettings,
  createMailTransport,
  isCapturedAddress,
  mailEnvValidationSchema,
  mailSettingsFromConfig,
  parseCaptureDomains,
  resolveMessageIdDomain,
} from '../mail.transport';

const mail = (to: string) => ({
  to,
  subject: 'Asunto',
  text: 'Texto',
  html: '<p>Texto</p>',
  messageId: '<mail-1@drinksonchain.com>',
});

function settings(overrides: Partial<MailSettings> = {}): MailSettings {
  return {
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    user: 'resend',
    password: 'clave-de-prueba',
    from: 'Drinks on Chain <no-reply@drinksonchain.com>',
    messageIdDomain: 'drinksonchain.com',
    capture: { domains: [], port: 1025 },
    ...overrides,
  };
}

/** Fábrica de dobles SMTP: guarda con qué servidor se creó cada uno. */
function fakeSmtp() {
  const created: {
    server: SmtpServerSettings;
    transport: jest.Mocked<MailTransport>;
  }[] = [];
  const factory = (server: SmtpServerSettings) => {
    const transport: jest.Mocked<MailTransport> = {
      send: jest.fn().mockResolvedValue({ messageId: `<x@${server.host}>` }),
      verify: jest.fn().mockResolvedValue(true),
      close: jest.fn(),
    };
    created.push({ server, transport });
    return transport;
  };
  return { created, factory };
}

describe('Captura de correo por dominio', () => {
  it('normaliza la lista de sufijos (espacios, mayúsculas, puntos, repetidos)', () => {
    expect(
      parseCaptureDomains(' Test, .EXAMPLE ,invalid,,localhost., test'),
    ).toEqual(['test', 'example', 'invalid', 'localhost']);
    expect(parseCaptureDomains('')).toEqual([]);
    expect(parseCaptureDomains(undefined)).toEqual([]);
  });

  it('coincide por etiqueta completa del dominio, sin mayúsculas', () => {
    const domains = ['test', 'example', 'invalid', 'localhost'];
    expect(isCapturedAddress('admin@altos.test', domains)).toBe(true);
    expect(isCapturedAddress('ADMIN@Altos.TEST', domains)).toBe(true);
    expect(isCapturedAddress('dev@example', domains)).toBe(true);
    expect(isCapturedAddress('a@b.c.localhost', domains)).toBe(true);
    expect(isCapturedAddress('Ana <ana@bodega.example>', domains)).toBe(true);
    // Sufijo que no es una etiqueta completa
    expect(isCapturedAddress('ana@contest.com', domains)).toBe(false);
    expect(isCapturedAddress('ana@contest', domains)).toBe(false);
    expect(isCapturedAddress('ana@test.com', domains)).toBe(false);
    expect(isCapturedAddress('ana@drinksonchain.com', domains)).toBe(false);
    expect(isCapturedAddress('no-es-un-correo', domains)).toBe(false);
  });

  it('un sufijo de varias etiquetas solo coincide con ese dominio y sus subdominios', () => {
    const domains = ['qa.drinksonchain.com'];
    expect(isCapturedAddress('a@qa.drinksonchain.com', domains)).toBe(true);
    expect(isCapturedAddress('a@x.qa.drinksonchain.com', domains)).toBe(true);
    expect(isCapturedAddress('a@drinksonchain.com', domains)).toBe(false);
    expect(isCapturedAddress('a@aqa.drinksonchain.com', domains)).toBe(false);
  });

  it('sin sufijos: solo el SMTP principal, como siempre', async () => {
    const { created, factory } = fakeSmtp();
    const transport = createMailTransport(settings(), factory);
    expect(created).toHaveLength(1);
    expect(transport).toBe(created[0].transport);
    expect(created[0].server).toMatchObject({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      user: 'resend',
    });
    await transport.send(mail('admin@altos.test'));
    expect(created[0].transport.send).toHaveBeenCalledTimes(1);
  });

  it('con sufijos: los de prueba al SMTP de captura y el resto al principal', async () => {
    const { created, factory } = fakeSmtp();
    const transport = createMailTransport(
      settings({
        capture: {
          domains: ['test', 'example'],
          host: 'mailpit',
          port: 1025,
        },
      }),
      factory,
    );
    expect(transport).toBeInstanceOf(RoutingMailTransport);
    const [primary, capture] = created;
    // Captura sin TLS ni autenticación
    expect(capture.server).toEqual({
      host: 'mailpit',
      port: 1025,
      secure: false,
      ignoreTls: true,
    });

    await transport.send(mail('Admin@Altos.Test'));
    await transport.send(mail('ana@contest.com'));
    await transport.send(mail('dev@bodega.example'));
    expect(capture.transport.send.mock.calls.map(([m]) => m.to)).toEqual([
      'Admin@Altos.Test',
      'dev@bodega.example',
    ]);
    expect(primary.transport.send.mock.calls.map(([m]) => m.to)).toEqual([
      'ana@contest.com',
    ]);
    // El Message-ID no depende del SMTP que entrega
    expect(capture.transport.send.mock.calls[0][0].messageId).toBe(
      primary.transport.send.mock.calls[0][0].messageId,
    );
  });

  it('con sufijos pero sin host de captura: error de configuración claro', () => {
    const { created, factory } = fakeSmtp();
    expect(() =>
      createMailTransport(
        settings({ capture: { domains: ['test'], port: 1025 } }),
        factory,
      ),
    ).toThrow(/MAIL_CAPTURE_DOMAINS.*MAIL_CAPTURE_SMTP_HOST/);
    expect(created).toHaveLength(0);
  });

  it('verify comprueba los dos SMTP y close cierra ambos', async () => {
    const { created, factory } = fakeSmtp();
    const transport = createMailTransport(
      settings({
        capture: { domains: ['test'], host: 'mailpit', port: 1025 },
      }),
      factory,
    );
    const [primary, capture] = created;
    await expect(transport.verify()).resolves.toBe(true);
    expect(primary.transport.verify).toHaveBeenCalledTimes(1);
    expect(capture.transport.verify).toHaveBeenCalledTimes(1);

    capture.transport.verify.mockResolvedValueOnce(false);
    await expect(transport.verify()).resolves.toBe(false);
    primary.transport.verify.mockResolvedValueOnce(false);
    await expect(transport.verify()).resolves.toBe(false);

    primary.transport.close.mockImplementationOnce(() => {
      throw new Error('ya cerrado');
    });
    expect(() => transport.close()).toThrow('ya cerrado');
    expect(capture.transport.close).toHaveBeenCalledTimes(1);
  });
});

describe('Variables de correo (Joi)', () => {
  const schema = Joi.object(mailEnvValidationSchema);

  it('sin variables de captura: válido y con el puerto 1025 por defecto', () => {
    const { error, value } = schema.validate({});
    expect(error).toBeUndefined();
    expect(value.MAIL_CAPTURE_SMTP_PORT).toBe(1025);
    expect(schema.validate({ MAIL_CAPTURE_DOMAINS: '' }).error).toBeUndefined();
  });

  it('con sufijos exige el host de captura', () => {
    for (const host of [undefined, '', '  ']) {
      const { error } = schema.validate({
        MAIL_CAPTURE_DOMAINS: 'test,example',
        MAIL_CAPTURE_SMTP_HOST: host,
      });
      expect(error?.message).toMatch(/MAIL_CAPTURE_SMTP_HOST es obligatorio/);
    }
    expect(
      schema.validate({
        MAIL_CAPTURE_DOMAINS: 'test,example,invalid,localhost',
        MAIL_CAPTURE_SMTP_HOST: 'mailpit',
        MAIL_CAPTURE_SMTP_PORT: '1025',
      }).error,
    ).toBeUndefined();
  });

  it('rechaza una lista de dominios mal formada y un dominio de Message-ID inválido', () => {
    expect(
      schema.validate({
        MAIL_CAPTURE_DOMAINS: 'test;example',
        MAIL_CAPTURE_SMTP_HOST: 'mailpit',
      }).error?.message,
    ).toMatch(/lista de dominios/);
    expect(
      schema.validate({ MAIL_MESSAGE_ID_DOMAIN: 'no es un dominio' }).error,
    ).toBeDefined();
    expect(
      schema.validate({ MAIL_MESSAGE_ID_DOMAIN: '' }).error,
    ).toBeUndefined();
  });

  it('mailSettingsFromConfig arma la captura y el dominio del Message-ID', () => {
    const env: Record<string, string> = {
      MAIL_FROM: 'Drinks on Chain <no-reply@DrinksOnChain.com>',
      MAIL_CAPTURE_DOMAINS: 'Test, example',
      MAIL_CAPTURE_SMTP_HOST: 'mailpit',
      MAIL_CAPTURE_SMTP_PORT: '1026',
      MAIL_MESSAGE_ID_DOMAIN: '',
    };
    const config = { get: (key: string) => env[key] } as ConfigService;
    expect(mailSettingsFromConfig(config)).toMatchObject({
      messageIdDomain: 'drinksonchain.com',
      capture: { domains: ['test', 'example'], host: 'mailpit', port: 1026 },
    });
  });
});

describe('Dominio del Message-ID', () => {
  it('MAIL_MESSAGE_ID_DOMAIN manda', () => {
    expect(
      resolveMessageIdDomain(' Mail.DrinksOnChain.com ', 'x <a@otro.com>'),
    ).toBe('mail.drinksonchain.com');
  });

  it('sin él, el dominio de la dirección de MAIL_FROM', () => {
    expect(
      resolveMessageIdDomain(
        undefined,
        'Drinks on Chain <no-reply@drinksonchain.com>',
      ),
    ).toBe('drinksonchain.com');
    expect(resolveMessageIdDomain('', 'no-reply@dev.drinksonchain.com')).toBe(
      'dev.drinksonchain.com',
    );
  });

  it('si no se puede sacar de MAIL_FROM, el valor por defecto', () => {
    expect(DEFAULT_MESSAGE_ID_DOMAIN).toBe('mail.drinksonchain.local');
    for (const from of [undefined, '', 'Drinks on Chain', 'x <a@>', 'a@b']) {
      expect(resolveMessageIdDomain(undefined, from)).toBe(
        DEFAULT_MESSAGE_ID_DOMAIN,
      );
    }
  });
});
