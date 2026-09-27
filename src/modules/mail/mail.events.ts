/** Eventos del outbox del módulo de correo (cola `email`). */
export const EMAIL_AGGREGATE = 'email_message';

/** Hay un correo que enviar. La carga solo lleva su id: el resto está en la fila. */
export const EMAIL_REQUESTED = 'email.requested';

export type EmailRequestedPayload = {
  emailMessageId: string;
};
