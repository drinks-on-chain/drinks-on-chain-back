import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { WineriesJobsModule } from '@modules/wineries/jobs/wineries-jobs.module';
import {
  WORKER_SETTINGS,
  workerEnvValidationSchema,
  workerSettingsFromConfig,
} from './worker.config';
import { QueueRegistry } from './queue-registry.service';
import { JobDispatcher } from './job-dispatcher.service';
import { OutboxRelayService } from './outbox-relay.service';
import { JobSchedulerService } from './job-scheduler.service';
import { HeartbeatService } from './heartbeat.service';
import { OutboxCleanupTask } from './tasks/outbox-cleanup.task';

/**
 * Módulos de dominio con procesadores de trabajos. Para añadir los de un
 * módulo nuevo, crea su `<modulo>-jobs.module.ts` y añádelo aquí.
 */
const JOB_MODULES = [WineriesJobsModule];

/**
 * Módulo raíz del proceso `worker` (src/worker.ts): sin HTTP. Publica el
 * outbox, procesa las colas, registra las tareas programadas y mantiene el
 * latido para el healthcheck.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: workerEnvValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    PrismaModule,
    DiscoveryModule,
    ...JOB_MODULES,
  ],
  providers: [
    {
      provide: WORKER_SETTINGS,
      useFactory: workerSettingsFromConfig,
      inject: [ConfigService],
    },
    QueueRegistry,
    JobDispatcher,
    OutboxRelayService,
    JobSchedulerService,
    HeartbeatService,
    OutboxCleanupTask,
  ],
  exports: [WORKER_SETTINGS],
})
export class WorkerModule {}
