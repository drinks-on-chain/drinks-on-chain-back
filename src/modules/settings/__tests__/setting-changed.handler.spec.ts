import { SettingChangedHandler } from '../jobs/setting-changed.handler';
import { InMemorySettingsCache } from '../settings.cache';

describe('SettingChangedHandler', () => {
  it('invalida la caché (nueva generación) y es idempotente', async () => {
    const cache = new InMemorySettingsCache();
    const handler = new SettingChangedHandler(cache);
    const data = {
      outboxEventId: 'evt-1',
      eventType: 'setting.changed',
      aggregateType: 'setting',
      aggregateId: 'canje.ventanaDias',
      payload: {
        key: 'canje.ventanaDias',
        scope: 'GLOBAL' as const,
        wineryIds: [],
      },
      correlationId: null,
      occurredAt: new Date().toISOString(),
    };
    await expect(cache.generation()).resolves.toBe('0');
    await handler.handle(data);
    await handler.handle(data);
    await expect(cache.generation()).resolves.toBe('2');
  });
});
