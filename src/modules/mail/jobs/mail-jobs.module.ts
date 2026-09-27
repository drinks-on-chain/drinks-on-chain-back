import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '@shared/prisma/prisma.module';
import {
  MAIL_SETTINGS,
  MAIL_TRANSPORT,
  MailSettings,
  MailTransport,
  SmtpMailTransport,
  mailSettingsFromConfig,
} from '../mail.transport';
import { EmailRequestedHandler } from './email-requested.handler';

/** Envío de correo en el worker: SMTP (`SMTP_*`, `MAIL_FROM`) y su procesador. */
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: MAIL_SETTINGS,
      inject: [ConfigService],
      useFactory: mailSettingsFromConfig,
    },
    {
      provide: MAIL_TRANSPORT,
      inject: [MAIL_SETTINGS],
      useFactory: (settings: MailSettings): MailTransport =>
        new SmtpMailTransport(settings),
    },
    EmailRequestedHandler,
  ],
  exports: [MAIL_TRANSPORT],
})
export class MailJobsModule implements OnApplicationShutdown {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
