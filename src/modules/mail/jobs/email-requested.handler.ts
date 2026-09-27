import { Inject, Injectable, Logger } from '@nestjs/common';
import { EmailStatusEnum, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { HandlesJob, JobContext, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_EMAIL } from '@shared/queue/queue.constants';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import { MailRenderer, MailVariables } from '../mail.renderer';
import { MAIL_TRANSPORT, MailTransport } from '../mail.transport';
import { EMAIL_REQUESTED, EmailRequestedPayload } from '../mail.events';

/** Un envío en SENDING más tiempo que esto se considera abandonado. */
export const EMAIL_SENDING_STALE_MS = 5 * 60_000;

/** Dominio del Message-ID (estable por correo, no depende del SMTP). */
const MESSAGE_ID_DOMAIN = 'mail.drinksonchain.local';

/**
 * Envía por SMTP un correo de `email_messages` (cola `email`).
 *
 * Idempotente por id de mensaje: un correo `SENT` no se vuelve a enviar, y el
 * envío se reclama con una actualización condicional (`QUEUED`/`FAILED` →
 * `SENDING`), así que dos ejecuciones del mismo trabajo no envían dos veces.
 * Queda un caso de "al menos una vez": si el proceso muere tras entregar al
 * SMTP y antes de marcar `SENT`, se reenvía con el mismo `Message-ID`.
 *
 * Si el SMTP falla, marca `FAILED` con el error y relanza para que BullMQ
 * reintente con espera exponencial. Al enviarse, borra las variables (pueden
 * llevar enlaces con token).
 */
@Injectable()
@HandlesJob(QUEUE_EMAIL, EMAIL_REQUESTED)
export class EmailRequestedHandler implements JobHandler<
  OutboxJobData<EmailRequestedPayload>
> {
  private readonly logger = new Logger(EmailRequestedHandler.name);
  private readonly renderer = new MailRenderer();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  async handle(
    data: OutboxJobData<EmailRequestedPayload>,
    context?: JobContext,
  ): Promise<void> {
    const id = data.payload.emailMessageId;
    if (!(await this.claim(id))) return;

    const message = await this.prisma.emailMessage.findUniqueOrThrow({
      where: { id },
    });
    try {
      const rendered = this.renderer.render(
        message.template,
        (message.variables ?? {}) as MailVariables,
      );
      const result = await this.transport.send({
        to: message.toAddress,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        messageId: `<${message.id}@${MESSAGE_ID_DOMAIN}>`,
        headers: { 'X-DOC-Email-Id': message.id },
      });
      await this.prisma.emailMessage.update({
        where: { id },
        data: {
          status: EmailStatusEnum.SENT,
          subject: rendered.subject,
          providerMessageId: result.messageId.slice(0, 300),
          sentAt: new Date(),
          lastError: null,
          variables: Prisma.DbNull,
        },
      });
      this.logger.log({
        message: `Correo ${message.template} enviado`,
        emailMessageId: id,
        template: message.template,
        attempt: context?.attempt ?? 1,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.prisma.emailMessage.update({
        where: { id },
        data: {
          status: EmailStatusEnum.FAILED,
          lastError: reason.slice(0, 2000),
        },
      });
      this.logger.warn({
        message: `No se pudo enviar el correo ${message.template}`,
        emailMessageId: id,
        attempt: context?.attempt ?? 1,
        error: reason,
      });
      throw error;
    }
  }

  /**
   * Pasa el correo a `SENDING` si nadie lo está enviando (o si el envío
   * anterior quedó abandonado). `false` = ya enviado, en curso o inexistente.
   */
  private async claim(id: string): Promise<boolean> {
    const { count } = await this.prisma.emailMessage.updateMany({
      where: {
        id,
        OR: [
          { status: { in: [EmailStatusEnum.QUEUED, EmailStatusEnum.FAILED] } },
          {
            status: EmailStatusEnum.SENDING,
            updatedAt: { lt: new Date(Date.now() - EMAIL_SENDING_STALE_MS) },
          },
        ],
      },
      data: { status: EmailStatusEnum.SENDING, attempts: { increment: 1 } },
    });
    if (count === 1) return true;

    const current = await this.prisma.emailMessage.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) {
      this.logger.warn({ message: 'Correo inexistente', emailMessageId: id });
    } else {
      this.logger.log({
        message: `Correo en estado ${current.status}: no se envía otra vez`,
        emailMessageId: id,
      });
    }
    return false;
  }
}
