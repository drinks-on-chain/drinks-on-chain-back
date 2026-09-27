import { Inject, Injectable, Logger } from '@nestjs/common';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import { SETTINGS_CACHE, SettingsCache } from '../settings.cache';
import { SETTING_CHANGED, SettingChangedPayload } from '../settings.events';

/**
 * Invalida la caché de configuración cuando se confirma un cambio. La API ya
 * la invalida al confirmar; esto cubre el caso en que Redis falló en ese
 * momento. Idempotente: invalidar dos veces solo cambia de generación.
 */
@Injectable()
@HandlesJob(QUEUE_DEFAULT, SETTING_CHANGED)
export class SettingChangedHandler implements JobHandler<
  OutboxJobData<SettingChangedPayload>
> {
  private readonly logger = new Logger(SettingChangedHandler.name);

  constructor(@Inject(SETTINGS_CACHE) private readonly cache: SettingsCache) {}

  async handle(data: OutboxJobData<SettingChangedPayload>): Promise<void> {
    await this.cache.invalidate();
    this.logger.log({
      message: `Caché de configuración invalidada por ${data.payload.key}`,
      key: data.payload.key,
      scope: data.payload.scope,
    });
  }
}
