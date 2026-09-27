import { Test, TestingModule } from '@nestjs/testing';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkerModule } from '../src/worker/worker.module';
import { WORKER_SETTINGS, WorkerSettings } from '../src/worker/worker.config';
import { QueueRegistry } from '../src/worker/queue-registry.service';
import { OutboxRelayService } from '../src/worker/outbox-relay.service';
import { OutboxJobData } from '../src/shared/outbox/outbox.types';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { MailModule } from '../src/modules/mail/mail.module';
import { MailService } from '../src/modules/mail/mail.service';
import { runWithCorrelationId } from '../src/shared/logging/correlation';

const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const run = `mail-${Date.now()}`;

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 30000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Tiempo agotado esperando la condición');
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  MessageID: string;
}

/**
 * Reclama el evento del outbox del correo (PENDING → DONE) y lo publica en la
 * cola `email` con `jobId` = id del evento, igual que el relay. Si otro relay
 * se adelantó, ya está en camino: no hace nada.
 */
async function publishOwnEvent(
  prisma: PrismaService,
  queues: QueueRegistry,
  emailMessageId: string,
): Promise<void> {
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateType: 'email_message', aggregateId: emailMessageId },
  });
  const { count } = await prisma.outboxEvent.updateMany({
    where: { id: event.id, status: 'PENDING' },
    data: { status: 'DONE', processedAt: new Date() },
  });
  if (count === 0) return;
  const data: OutboxJobData = {
    outboxEventId: event.id,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload as Record<string, unknown>,
    correlationId: event.correlationId,
    occurredAt: event.createdAt.toISOString(),
  };
  await queues.get('email').add(event.eventType, data, { jobId: event.id });
}

/**
 * Correo de extremo a extremo con Postgres, Redis y Mailpit reales: la API
 * encola (fila + outbox en una transacción), el evento se publica en la cola
 * `email`, el procesador del worker lo envía por SMTP y el mensaje se lee en
 * Mailpit.
 */
describe('Correo por la cola hasta Mailpit (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let mail: MailService;
  let queues: QueueRegistry;
  const to = `${run}@example.test`;

  const settings: WorkerSettings = {
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    queuePrefix: run,
    concurrency: 2,
    jobAttempts: 3,
    jobBackoffMs: 200,
    relay: {
      intervalMs: 100,
      batchSize: 20,
      maxAttempts: 3,
      retryBaseMs: 200,
      retryMaxMs: 2000,
      lockTimeoutMs: 60000,
    },
    retentionDays: 7,
    heartbeat: { file: join(tmpdir(), `${run}.heartbeat`), intervalMs: 1000 },
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule, MailModule],
    })
      .overrideProvider(WORKER_SETTINGS)
      .useValue(settings)
      // Sin relay propio: otro e2e con su relay en marcha a la vez podría
      // quedarse con eventos ajenos. El evento de este correo lo publica la
      // prueba como lo haría el relay (ver publishOwnEvent).
      .overrideProvider(OutboxRelayService)
      .useValue({
        onApplicationBootstrap: () => undefined,
        onModuleDestroy: async () => undefined,
        start: () => undefined,
        stop: async () => undefined,
        isRunning: () => true,
        msSinceLastTick: () => 0,
      })
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    mail = moduleRef.get(MailService);
    queues = moduleRef.get(QueueRegistry);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.outboxEvent.deleteMany({
        where: { correlationId: { startsWith: run } },
      });
      await prisma.emailMessage.deleteMany({ where: { toAddress: to } });
    }
    if (queues) {
      await Promise.allSettled(
        queues.all().map((q) => q.obliterate({ force: true })),
      );
    }
    await moduleRef?.close();
  });

  it('encola un correo de prueba, el worker lo envía y llega a Mailpit', async () => {
    const message = await runWithCorrelationId(`${run}-send`, () =>
      mail.enqueueStandalone({
        template: 'prueba',
        to,
        variables: { nombre: 'Equipo', entorno: run },
        idempotencyKey: `${run}:prueba`,
      }),
    );

    // Misma clave: el mismo correo, sin un segundo envío
    const again = await mail.enqueueStandalone({
      template: 'prueba',
      to,
      variables: { nombre: 'Equipo', entorno: run },
      idempotencyKey: `${run}:prueba`,
    });
    expect(again.id).toBe(message.id);
    await expect(
      prisma.outboxEvent.count({
        where: { aggregateType: 'email_message', aggregateId: message.id },
      }),
    ).resolves.toBe(1);

    await publishOwnEvent(prisma, queues, message.id);

    const sent = await waitFor(async () => {
      const row = await prisma.emailMessage.findUnique({
        where: { id: message.id },
      });
      return row?.status === 'SENT' ? row : null;
    });
    expect(sent).toMatchObject({
      subject: `Correo de prueba de Drinks on Chain (${run})`,
      attempts: 1,
      variables: null,
    });

    const found = await waitFor(async () => {
      const res = await fetch(
        `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { messages: MailpitMessage[] };
      return body.messages.length > 0 ? body.messages : null;
    });
    expect(found).toHaveLength(1);
    expect(found[0].Subject).toBe(
      `Correo de prueba de Drinks on Chain (${run})`,
    );
    expect(found[0].MessageID).toBe(`${message.id}@mail.drinksonchain.local`);

    const detail = (await (
      await fetch(`${MAILPIT_API_URL}/api/v1/message/${found[0].ID}`)
    ).json()) as { Text: string; HTML: string };
    expect(detail.Text).toContain('Hola, Equipo:');
    expect(detail.HTML).toContain('Drinks on Chain');
  });
});
