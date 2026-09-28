import {
  getRequestContext,
  identityFromUser,
  parseClientApp,
  runWithRequestContext,
  setRequestContext,
} from '../request-context';
import { runWithCorrelationId } from '@shared/logging/correlation';
import { CorrelationIdMiddleware } from '@shared/middleware/correlation-id.middleware';

describe('RequestContext', () => {
  it('fuera de un contexto no hay nada y actualizar no falla', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(() => setRequestContext({ userId: 'x' })).not.toThrow();
  });

  it('se completa dentro del contexto asíncrono', async () => {
    await runWithRequestContext({ correlationId: 'c-1' }, async () => {
      await Promise.resolve();
      setRequestContext({ userId: 'u-1' });
      expect(getRequestContext()).toMatchObject({
        correlationId: 'c-1',
        userId: 'u-1',
        organizationId: null,
        clientApp: null,
      });
    });
  });

  it('X-Client-App: valores conocidos, WORKER y desconocidos → API, ausente → null', () => {
    expect(parseClientApp('erp')).toBe('ERP');
    expect(parseClientApp(['BACKOFFICE'])).toBe('BACKOFFICE');
    expect(parseClientApp('WORKER')).toBe('API');
    expect(parseClientApp('hacker')).toBe('API');
    expect(parseClientApp(undefined)).toBeNull();
  });

  it('ignora los claims de compatibilidad retirados en H1 (wineryId, memberRole, userRole)', () => {
    expect(
      identityFromUser({
        id: 'u-1',
        fullName: 'Ana',
        organizationId: 'w-1',
        organizationType: 'WINERY',
        role: 'OWNER',
        userRole: 'PLATFORM_ADMIN',
        wineryId: 'w-2',
        memberRole: 'ENOLOGIST',
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
      identityFromUser({ id: 'u-2', userRole: 'CONSUMER', wineryId: 'w-1' }),
    ).toMatchObject({
      audience: 'CONSUMER',
      organizationId: null,
      organizationType: null,
      role: null,
    });
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
      expect(getRequestContext()?.clientApp).toBe('WORKER');
    });
  });
});
