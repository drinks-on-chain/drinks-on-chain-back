import { Injectable } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { JobSchedulerService } from '../job-scheduler.service';
import { ScheduledTask } from '@shared/queue/job-handler';
import { QueueRegistry } from '../queue-registry.service';

@Injectable()
@ScheduledTask({ name: 'cron.task', pattern: '0 * * * *' })
class CronTask {
  async handle(): Promise<void> {}
}

@Injectable()
@ScheduledTask({ name: 'every.task', every: 60000 })
class EveryTask {
  async handle(): Promise<void> {}
}

describe('JobSchedulerService', () => {
  it('registra las tareas del código y elimina las que ya no existen', async () => {
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue({}),
      getJobSchedulers: jest
        .fn()
        .mockResolvedValue([
          { key: 'cron.task' },
          { key: 'every.task' },
          { key: 'old.task' },
        ]),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    const queues = { get: jest.fn().mockReturnValue(queue) };
    const discovery = {
      getProviders: () => [
        { metatype: CronTask, instance: new CronTask() },
        { metatype: EveryTask, instance: new EveryTask() },
        { metatype: Object, instance: {} },
      ],
    } as unknown as DiscoveryService;

    const service = new JobSchedulerService(
      discovery,
      new Reflector(),
      queues as unknown as QueueRegistry,
    );
    await service.onApplicationBootstrap();

    expect(queues.get).toHaveBeenCalledWith('scheduled');
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'cron.task',
      { pattern: '0 * * * *', tz: 'UTC' },
      expect.objectContaining({ name: 'cron.task', data: {} }),
    );
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'every.task',
      { every: 60000 },
      expect.objectContaining({ name: 'every.task' }),
    );
    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('old.task');
    expect(service.scheduledTasks().map((t) => t.name)).toEqual([
      'cron.task',
      'every.task',
    ]);
  });
});
