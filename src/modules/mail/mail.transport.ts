import * as Joi from 'joi';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

/** Dominio del Message-ID si no se configura ni se puede sacar de `MAIL_FROM`. */
export const DEFAULT_MESSAGE_ID_DOMAIN = 'mail.drinksonchain.local';

const DEFAULT_MAIL_FROM = 'Drinks on Chain <no-reply@drinksonchain.local>';

/** Sufijos de dominio separados por comas (`test,example,invalid,localhost`). */
const DOMAIN_LIST_PATTERN =
  /^\s*\.?[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\s*(,\s*\.?[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\s*)*,?\s*$/;

/** Nombre de host práctico (etiquetas separadas por puntos, al menos dos). */
const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const CAPTURE_HOST_REQUIRED =
  'MAIL_CAPTURE_SMTP_HOST es obligatorio cuando MAIL_CAPTURE_DOMAINS tiene dominios';

/** Variables del SMTP (las lee el worker). Por defecto, Mailpit en local. */
export const mailEnvValidationSchema = {
  SMTP_HOST: Joi.string().default('localhost'),
  SMTP_PORT: Joi.number().port().default(1025),
  // true = TLS directo (465); false = STARTTLS si el servidor lo ofrece
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASSWORD: Joi.string().allow('').optional(),
  MAIL_FROM: Joi.string().default(DEFAULT_MAIL_FROM),
  MAIL_REPLY_TO: Joi.string().allow('').optional(),
  // Captura: los destinatarios de estos sufijos de dominio van a un SMTP de
  // captura (Mailpit) en lugar del principal. Vacío = sin captura
  MAIL_CAPTURE_DOMAINS: Joi.string()
    .allow('')
    .pattern(DOMAIN_LIST_PATTERN)
    .optional()
    .messages({
      'string.pattern.base':
        'MAIL_CAPTURE_DOMAINS debe ser una lista de dominios separados por comas (p. ej. test,example,invalid,localhost)',
    }),
  // SMTP de captura: sin TLS ni autenticación. Obligatorio si hay sufijos
  MAIL_CAPTURE_SMTP_HOST: Joi.string().when('MAIL_CAPTURE_DOMAINS', {
    is: Joi.string()
      .pattern(/[a-zA-Z0-9]/)
      .required(),
    then: Joi.string().trim().required().messages({
      'any.required': CAPTURE_HOST_REQUIRED,
      'string.empty': CAPTURE_HOST_REQUIRED,
    }),
    otherwise: Joi.string().allow('').optional(),
  }),
  MAIL_CAPTURE_SMTP_PORT: Joi.number().port().default(1025),
  // Dominio del Message-ID. Vacío = el de la dirección de MAIL_FROM
  MAIL_MESSAGE_ID_DOMAIN: Joi.string().allow('').hostname().optional(),
};

export const MAIL_SETTINGS = Symbol('MAIL_SETTINGS');
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/** Conexión a un servidor SMTP. */
export interface SmtpServerSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  /** true = no intenta STARTTLS aunque el servidor lo ofrezca. */
  ignoreTls?: boolean;
}

/** SMTP de captura para los dominios de prueba (`MAIL_CAPTURE_*`). */
export interface MailCaptureSettings {
  /** Sufijos normalizados (minúsculas, sin puntos en los extremos). */
  domains: string[];
  /** Vacío con sufijos = error de configuración al construir el transporte. */
  host?: string;
  port: number;
}

export interface MailSettings extends SmtpServerSettings {
  from: string;
  replyTo?: string;
  /** Dominio del Message-ID (`<id>@<dominio>`). */
  messageIdDomain: string;
  /** Sin sufijos = sin captura (todo por el SMTP principal). */
  capture: MailCaptureSettings;
}

/** `" Test, .Example ,"` → `['test', 'example']`. */
export function parseCaptureDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  const domains = raw
    .split(',')
    .map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, ''),
    )
    .filter((part) => part !== '');
  return [...new Set(domains)];
}

/** Dominio de una dirección (`Ana <ana@Altos.Test>` → `altos.test`). */
export function domainOfAddress(address: string): string | undefined {
  const angle = /<([^>]*)>/.exec(address);
  const bare = (angle ? angle[1] : address).trim();
  const at = bare.lastIndexOf('@');
  if (at < 0) return undefined;
  const domain = bare
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '');
  return domain === '' ? undefined : domain;
}

/**
 * ¿El dominio del destinatario termina en uno de los sufijos? Por etiqueta
 * completa y sin mayúsculas: `altos.test` coincide con `test`; `contest.com`
 * y `contest` no.
 */
export function isCapturedAddress(
  address: string,
  domains: readonly string[],
): boolean {
  if (domains.length === 0) return false;
  const domain = domainOfAddress(address);
  if (!domain) return false;
  return domains.some(
    (suffix) => domain === suffix || domain.endsWith(`.${suffix}`),
  );
}

/**
 * Dominio del Message-ID: `MAIL_MESSAGE_ID_DOMAIN` si está; si no, el de la
 * dirección de `MAIL_FROM`; si no se puede sacar, el valor por defecto.
 */
export function resolveMessageIdDomain(
  explicit: string | undefined,
  from: string | undefined,
): string {
  const configured = explicit?.trim().toLowerCase();
  if (configured) return configured;
  const fromDomain = from ? domainOfAddress(from) : undefined;
  if (fromDomain && HOSTNAME_PATTERN.test(fromDomain)) return fromDomain;
  return DEFAULT_MESSAGE_ID_DOMAIN;
}

export function mailSettingsFromConfig(config: ConfigService): MailSettings {
  const text = (key: string) => {
    const value = config.get<string>(key);
    return value && String(value).trim() !== ''
      ? String(value).trim()
      : undefined;
  };
  const from = text('MAIL_FROM') ?? DEFAULT_MAIL_FROM;
  return {
    host: text('SMTP_HOST') ?? 'localhost',
    port: Number(config.get('SMTP_PORT') ?? 1025),
    secure: String(config.get('SMTP_SECURE') ?? 'false') === 'true',
    user: text('SMTP_USER'),
    password: text('SMTP_PASSWORD'),
    from,
    replyTo: text('MAIL_REPLY_TO'),
    messageIdDomain: resolveMessageIdDomain(
      text('MAIL_MESSAGE_ID_DOMAIN'),
      from,
    ),
    capture: {
      domains: parseCaptureDomains(text('MAIL_CAPTURE_DOMAINS')),
      host: text('MAIL_CAPTURE_SMTP_HOST'),
      port: Number(config.get('MAIL_CAPTURE_SMTP_PORT') ?? 1025),
    },
  };
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Message-ID estable: el mismo correo reenviado tiene el mismo id. */
  messageId: string;
  headers?: Record<string, string>;
}

/** Envío real de un correo (SMTP en la app; un doble en las pruebas). */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  verify(): Promise<boolean>;
  close(): void;
}

export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;

  constructor(
    server: SmtpServerSettings,
    private readonly sender: { from: string; replyTo?: string },
  ) {
    this.transporter = createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      ignoreTLS: server.ignoreTls ?? false,
      auth:
        server.user && server.password
          ? { user: server.user, pass: server.password }
          : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    const info = await this.transporter.sendMail({
      from: this.sender.from,
      replyTo: this.sender.replyTo,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      messageId: mail.messageId,
      headers: mail.headers,
    });
    return { messageId: String(info.messageId ?? mail.messageId) };
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.transporter.close();
  }
}

/**
 * Enruta por dominio del destinatario: los sufijos de captura (`.test`,
 * `.example`…) van al SMTP de captura (Mailpit) y el resto al principal
 * (p. ej. Resend). Así la semilla y las e2e no rebotan en el proveedor real.
 */
export class RoutingMailTransport implements MailTransport {
  constructor(
    private readonly primary: MailTransport,
    private readonly capture: MailTransport,
    private readonly domains: readonly string[],
  ) {}

  send(mail: OutgoingMail): Promise<{ messageId: string }> {
    return this.route(mail.to).send(mail);
  }

  /** Transporte que usaría un destinatario. */
  route(address: string): MailTransport {
    return isCapturedAddress(address, this.domains)
      ? this.capture
      : this.primary;
  }

  async verify(): Promise<boolean> {
    const [primary, capture] = await Promise.all([
      this.primary.verify(),
      this.capture.verify(),
    ]);
    return primary && capture;
  }

  close(): void {
    try {
      this.primary.close();
    } finally {
      this.capture.close();
    }
  }
}

/**
 * Transporte del worker. Sin sufijos de captura: solo el SMTP principal (como
 * siempre). Con sufijos: enrutado, y falta de host de captura = error de
 * configuración (no arranca).
 */
export function createMailTransport(
  settings: MailSettings,
  smtp: (
    server: SmtpServerSettings,
    sender: { from: string; replyTo?: string },
  ) => MailTransport = (server, sender) =>
    new SmtpMailTransport(server, sender),
): MailTransport {
  const sender = { from: settings.from, replyTo: settings.replyTo };
  const { domains, host, port } = settings.capture;
  if (domains.length > 0 && !host) {
    throw new Error(
      `Configuración de correo inválida: MAIL_CAPTURE_DOMAINS (${domains.join(',')}) necesita MAIL_CAPTURE_SMTP_HOST`,
    );
  }
  const primary = smtp(settings, sender);
  if (domains.length === 0 || !host) return primary;
  const capture = smtp({ host, port, secure: false, ignoreTls: true }, sender);
  return new RoutingMailTransport(primary, capture, domains);
}
