import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';
import { JsonLogger } from './shared/logging/json-logger';
import { HeartbeatService } from './worker/heartbeat.service';
import { OutboxRelayService } from './worker/outbox-relay.service';
import { JobDispatcher } from './worker/job-dispatcher.service';

/** Tiempo máximo para terminar los trabajos en curso al parar. */
const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Proceso `worker` (docs-back/03 §2 y §4): outbox → BullMQ, procesadores de
 * las colas `chain`, `email`, `scheduled` y `default`, tareas programadas y
 * latido. Sin servidor HTTP. Misma imagen que la API: `node dist/worker.js`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new JsonLogger('worker'),
  });
  const logger = new Logger('Worker');
  logger.log('Worker en marcha');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} recibido: apagado ordenado`);
    const killer = setTimeout(() => {
      logger.error('El apagado superó el tiempo máximo; se fuerza la salida');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    killer.unref();
    try {
      // 1. Deja de declararse sano, 2. no toma más eventos del outbox,
      // 3. espera a los trabajos en curso, 4. cierra conexiones.
      await app.get(HeartbeatService).stop();
      await app.get(OutboxRelayService).stop();
      await app.get(JobDispatcher).close();
      await app.close();
      logger.log('Worker detenido');
      process.exit(0);
    } catch (error) {
      logger.error(
        `Error durante el apagado: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error: unknown) => {
  new Logger('Worker').error(
    `El worker no pudo arrancar: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
