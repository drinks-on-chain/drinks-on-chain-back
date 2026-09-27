import { Reflector } from '@nestjs/core';
import { OutboxStatusEnum } from '@prisma/client';
import {
  OUTBOX_CLEANUP_TASK,
  OutboxCleanupTask,
} from '../tasks/outbox-cleanup.task';
import {
  JOB_HANDLER_METADATA,
  SCHEDULED_TASK_METADATA,
} from '@shared/queue/job-handler';
import { PrismaService } from '@shared/prisma/prisma.service';
import { WorkerSettings } from '../worker.config';

describe('OutboxCleanupTask', () => {
  it('borra solo los eventos DONE procesados antes del plazo de retención', async () => {
    const prisma = {
      outboxEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 4 }) },
    };
    const task = new OutboxCleanupTask(
      prisma as unknown as PrismaService,
      { retentionDays: 7 } as WorkerSettings,
    );

    const count = await task.run(new Date('2026-09-27T12:00:00.000Z'));

    expect(count).toBe(4);
    expect(prisma.outboxEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        status: OutboxStatusEnum.DONE,
        processedAt: { lt: new Date('2026-09-20T12:00:00.000Z') },
      },
    });
  });

  it('es una tarea programada de la cola scheduled', () => {
    const reflector = new Reflector();
    expect(reflector.get(JOB_HANDLER_METADATA, OutboxCleanupTask)).toEqual({
      queue: 'scheduled',
      name: OUTBOX_CLEANUP_TASK,
    });
    expect(
      reflector.get(SCHEDULED_TASK_METADATA, OutboxCleanupTask),
    ).toMatchObject({ name: OUTBOX_CLEANUP_TASK, pattern: '17 * * * *' });
  });
});
