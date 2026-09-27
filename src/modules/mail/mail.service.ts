import { Injectable } from '@nestjs/common';
import { EmailMessage, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { OutboxService } from '@shared/outbox/outbox.service';
import { QUEUE_EMAIL } from '@shared/queue/queue.constants';
import { getRequestContext } from '@shared/context/request-context';
import { mailTemplate } from './templates';
import { MailRenderer, MailVariables } from './mail.renderer';
import {
  EMAIL_AGGREGATE,
  EMAIL_REQUESTED,
  EmailRequestedPayload,
} from './mail.events';

export interface EnqueueMailInput {
  /** Nombre de la plantilla (`src/modules/mail/templates`). */
  template: string;
  to: string;
  variables: MailVariables;
  /**
   * Clave estable del correo (p. ej. `invitation:<id>:v1`). Si ya existe un
   * correo con esa clave, se devuelve ese y no se crea otro.
   */
  idempotencyKey?: string;
  /** Organización a la que pertenece el correo (para consultarlo después). */
  organizationId?: string | null;
}

/** Formato práctico de una dirección (el SMTP hace la validación real). */
const EMAIL_PATTERN =
  /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

/**
 * Correo transaccional (CMP-01). La API no envía: escribe el correo y su
 * evento `email.requested` en la misma transacción que la operación (si se
 * revierte, no sale ningún correo) y el worker lo envía por SMTP desde la
 * cola `email`, con reintentos.
 */
@Injectable()
export class MailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** Encola un correo dentro de la transacción `tx`. */
  async enqueue(
    tx: Prisma.TransactionClient,
    input: EnqueueMailInput,
  ): Promise<EmailMessage> {
    const template = mailTemplate(input.template);
    if (!template) {
      throw new Error(`Plantilla de correo desconocida: ${input.template}`);
    }
    // Falla aquí, no en el worker, si faltan variables o no son simples
    MailRenderer.checkVariables(template, input.variables);
    const to = (input.to ?? '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(to) || to.length > 255) {
      throw new Error(`Dirección de correo inválida: ${input.to}`);
    }

    if (input.idempotencyKey) {
      const existing = await tx.emailMessage.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return existing;
    }

    const message = await tx.emailMessage.create({
      data: {
        idempotencyKey: input.idempotencyKey ?? null,
        template: template.name,
        toAddress: to,
        variables: input.variables as Prisma.InputJsonObject,
        organizationId: input.organizationId ?? null,
        correlationId: getRequestContext()?.correlationId ?? null,
      },
    });
    await this.outbox.add<EmailRequestedPayload>(tx, {
      type: EMAIL_REQUESTED,
      aggregateType: EMAIL_AGGREGATE,
      aggregateId: message.id,
      queue: QUEUE_EMAIL,
      payload: { emailMessageId: message.id },
    });
    return message;
  }

  /** Encola un correo que no acompaña a otra escritura (su propia transacción). */
  async enqueueStandalone(input: EnqueueMailInput): Promise<EmailMessage> {
    return this.prisma.$transaction((tx) => this.enqueue(tx, input));
  }
}
