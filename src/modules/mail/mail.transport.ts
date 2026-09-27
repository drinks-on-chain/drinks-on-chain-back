import * as Joi from 'joi';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

/** Variables del SMTP (las lee el worker). Por defecto, Mailpit en local. */
export const mailEnvValidationSchema = {
  SMTP_HOST: Joi.string().default('localhost'),
  SMTP_PORT: Joi.number().port().default(1025),
  // true = TLS directo (465); false = STARTTLS si el servidor lo ofrece
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASSWORD: Joi.string().allow('').optional(),
  MAIL_FROM: Joi.string().default(
    'Drinks on Chain <no-reply@drinksonchain.local>',
  ),
  MAIL_REPLY_TO: Joi.string().allow('').optional(),
};

export const MAIL_SETTINGS = Symbol('MAIL_SETTINGS');
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface MailSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  replyTo?: string;
}

export function mailSettingsFromConfig(config: ConfigService): MailSettings {
  const text = (key: string) => {
    const value = config.get<string>(key);
    return value && value.trim() !== '' ? value.trim() : undefined;
  };
  return {
    host: text('SMTP_HOST') ?? 'localhost',
    port: Number(config.get('SMTP_PORT') ?? 1025),
    secure: String(config.get('SMTP_SECURE') ?? 'false') === 'true',
    user: text('SMTP_USER'),
    password: text('SMTP_PASSWORD'),
    from: text('MAIL_FROM') ?? 'Drinks on Chain <no-reply@drinksonchain.local>',
    replyTo: text('MAIL_REPLY_TO'),
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

  constructor(private readonly settings: MailSettings) {
    this.transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth:
        settings.user && settings.password
          ? { user: settings.user, pass: settings.password }
          : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    const info = await this.transporter.sendMail({
      from: this.settings.from,
      replyTo: this.settings.replyTo,
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
