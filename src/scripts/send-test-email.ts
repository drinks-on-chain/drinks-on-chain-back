import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '../shared/prisma/prisma.module';
import { JsonLogger } from '../shared/logging/json-logger';
import { runWithCorrelationId } from '../shared/logging/correlation';
import { MailModule } from '../modules/mail/mail.module';
import { MailService } from '../modules/mail/mail.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, MailModule],
})
class SendTestEmailModule {}

/**
 * Encola el correo de prueba (plantilla `prueba`) para comprobar la cola y el
 * SMTP en un entorno. Lo envía el worker.
 *
 *   node dist/scripts/send-test-email.js destino@example.com
 *   docker compose -p doc-dev exec api node dist/scripts/send-test-email.js dev@example.test
 */
async function main(): Promise<void> {
  const to = process.argv[2];
  if (!to) {
    throw new Error('uso: send-test-email <destino@dominio>');
  }
  const app = await NestFactory.createApplicationContext(SendTestEmailModule, {
    logger: new JsonLogger('script'),
  });
  try {
    const correlationId = `test-email-${Date.now()}`;
    const message = await runWithCorrelationId(correlationId, () =>
      app.get(MailService).enqueueStandalone({
        template: 'prueba',
        to,
        variables: {
          nombre: 'equipo',
          entorno: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'local',
        },
      }),
    );
    new Logger('SendTestEmail').log({
      message: `Correo de prueba encolado: ${message.id}`,
      emailMessageId: message.id,
      correlationId,
    });
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  new Logger('SendTestEmail').error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
