import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import {
  SCHEDULED_TASK_METADATA,
  ScheduledTaskMetadata,
} from '@shared/queue/job-handler';
import { QUEUE_SCHEDULED } from '@shared/queue/queue.constants';
import { QueueRegistry } from './queue-registry.service';

/**
 * Registra en BullMQ (job schedulers de la cola `scheduled`) las tareas
 * marcadas con `@ScheduledTask` y elimina las que ya no existen en el código.
 * Es idempotente: varias réplicas del worker pueden ejecutarlo a la vez.
 */
@Injectable()
export class JobSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobSchedulerService.name);
  private tasks: ScheduledTaskMetadata[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly queues: QueueRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.tasks = this.discoverTasks();
    await this.sync();
  }

  scheduledTasks(): ScheduledTaskMetadata[] {
    return [...this.tasks];
  }

  private discoverTasks(): ScheduledTaskMetadata[] {
    const tasks: ScheduledTaskMetadata[] = [];
    for (const { metatype } of this.discovery.getProviders()) {
      if (!metatype) continue;
      const meta = this.reflector.get<ScheduledTaskMetadata | undefined>(
        SCHEDULED_TASK_METADATA,
        metatype,
      );
      if (meta) tasks.push(meta);
    }
    return tasks;
  }

  async sync(): Promise<void> {
    const queue = this.queues.get(QUEUE_SCHEDULED);
    const wanted = new Set(this.tasks.map((t) => t.name));

    for (const task of this.tasks) {
      const repeat =
        task.every !== undefined
          ? { every: task.every }
          : { pattern: task.pattern, tz: 'UTC' };
      await queue.upsertJobScheduler(task.name, repeat, {
        name: task.name,
        data: {},
        opts: {
          attempts: 1,
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 50 },
        },
      });
      this.logger.log(
        `Tarea programada ${task.name}: ${task.every !== undefined ? `cada ${task.every} ms` : `cron "${task.pattern}" (UTC)`}`,
      );
    }

    const existing = await queue.getJobSchedulers();
    for (const scheduler of existing) {
      if (!wanted.has(scheduler.key)) {
        await queue.removeJobScheduler(scheduler.key);
        this.logger.log(`Tarea programada ${scheduler.key} eliminada`);
      }
    }
  }
}
