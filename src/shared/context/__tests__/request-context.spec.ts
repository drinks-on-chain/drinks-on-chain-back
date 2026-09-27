import {
  createRequestContext,
  currentRequestContext,
  identityFromUser,
  parseClientApp,
  runWithRequestContext,
  updateRequestContext,
} from '../request-context';
import { runWithCorrelationId } from '@shared/logging/correlation';
import { CorrelationIdMiddleware } from '@shared/middleware/correlation-id.middleware';

describe('RequestContext', () => {
  it('fuera de un contexto no hay nada y actualizar no falla', () => {
    expect(currentRequestContext()).toBeUndefined();
    expect(() => updateRequestContext({ userId: 'x' })).not.toThrow();
  });

  it('se completa dentro del contexto asíncrono', async () => {
    const ctx = createRequestContext({ correlationId: 'c-1' });
    await runWithRequestContext(ctx, async () => {
      await Promise.resolve();
      updateRequestContext({ userId: 'u-1', organizationId: undefined });
      expect(currentRequestContext()).toMatchObject({
        correlationId: 'c-1',
        userId: 'u-1',
        organizationId: null,
        clientApp: 'API',
      });
    });
  });

  it('X-Client-App: valores conocidos, WORKER y desconocidos → API', () => {
    expect(parseClientApp('erp')).toBe('ERP');
    expect(parseClientApp(['BACKOFFICE'])).toBe('BACKOFFICE');
    expect(parseClientApp('WORKER')).toBe('API');
    expect(parseClientApp('hacker')).toBe('API');
    expect(parseClientApp(undefined)).toBe('API');
  });

  it('identidad con los claims actuales (wineryId, memberRole, userRole)', () => {
    expect(
      identityFromUser({
        id: 'u-1',
        fullName: 'Ana',
        userRole: 'WINERY_ADMIN',
        wineryId: 'w-1',
        memberRole: 'OWNER',
      }),
    ).toEqual({
      userId: 'u-1',
      userFullName: 'Ana',
      organizationId: 'w-1',
      organizationType: 'WINERY',
      role: 'OWNER',
      sessionId: null,
      audience: 'STAFF',
    });
    expect(
      identityFromUser({ id: 'u-2', userRole: 'CONSUMER', wineryId: null }),
    ).toMatchObject({
      audience: 'CONSUMER',
      organizationId: null,
      role: 'CONSUMER',
    });
    expect(
      identityFromUser({ id: 'u-3', userRole: 'PLATFORM_ADMIN' }),
    ).toMatchObject({ organizationType: 'PLATFORM', audience: 'STAFF' });
  });

  it('identidad con los claims nuevos del contrato O0 (org, orgType, role, sid, aud)', () => {
    expect(
      identityFromUser({
        sub: 'u-9',
        org: 'o-1',
        orgType: 'PLATFORM',
        role: 'ADMIN',
        sid: 's-1',
        aud: 'STAFF',
      }),
    ).toMatchObject({
      userId: 'u-9',
      organizationId: 'o-1',
      organizationType: 'PLATFORM',
      role: 'ADMIN',
      sessionId: 's-1',
      audience: 'STAFF',
    });
    expect(identityFromUser(undefined)).toBeNull();
    expect(identityFromUser({ email: 'sin-id' })).toBeNull();
  });

  it('el worker ejecuta con app WORKER y el correlationId del evento', () => {
    runWithCorrelationId('evt-corr', () => {
      expect(CorrelationIdMiddleware.getCorrelationId()).toBe('evt-corr');
      expect(currentRequestContext()?.clientApp).toBe('WORKER');
    });
  });
});
