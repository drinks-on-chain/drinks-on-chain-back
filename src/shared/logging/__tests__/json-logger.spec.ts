import { JsonLogger } from '../json-logger';
import { runWithCorrelationId } from '../correlation';
import {
  createRequestContext,
  runWithRequestContext,
} from '@shared/context/request-context';

describe('JsonLogger', () => {
  const logger = new JsonLogger('worker');

  it('incluye servicio, fecha ISO y contexto', () => {
    const entry = logger.buildEntry('hola', {
      context: 'Relay',
      logLevel: 'log',
    });
    expect(entry).toMatchObject({
      level: 'log',
      service: 'worker',
      context: 'Relay',
      message: 'hola',
    });
    expect(typeof entry.timestamp).toBe('string');
    expect(new Date(entry.timestamp as string).toISOString()).toBe(
      entry.timestamp,
    );
    expect(entry).not.toHaveProperty('correlationId');
  });

  it('añade el correlationId del contexto asíncrono', () => {
    const entry = runWithCorrelationId('corr-9', () =>
      logger.buildEntry('hola', { context: 'Relay', logLevel: 'warn' }),
    );
    expect(entry.correlationId).toBe('corr-9');
  });

  it('escribe una línea JSON por entrada', () => {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      runWithCorrelationId('corr-1', () => logger.log('mensaje', 'Ctx'));
      const line = String(write.mock.calls[0][0]);
      expect(line.endsWith('\n')).toBe(true);
      expect(JSON.parse(line)).toMatchObject({
        message: 'mensaje',
        context: 'Ctx',
        correlationId: 'corr-1',
        service: 'worker',
      });
    } finally {
      write.mockRestore();
    }
  });

  it('añade sesión, organización y persona del contexto de la petición', () => {
    const entry = runWithRequestContext(
      createRequestContext({
        correlationId: 'corr-2',
        sessionId: 'sid-1',
        organizationId: 'org-1',
        userId: 'user-1',
        clientApp: 'ERP',
      }),
      () => logger.buildEntry('hola', { context: 'HTTP', logLevel: 'log' }),
    );
    expect(entry).toMatchObject({
      correlationId: 'corr-2',
      sid: 'sid-1',
      org: 'org-1',
      userId: 'user-1',
      app: 'ERP',
    });
  });

  it('un mensaje objeto va al primer nivel y saneado', () => {
    const entry = logger.buildEntry(
      { message: 'GET /v1/health 200', statusCode: 200, password: 'x' },
      { context: 'HTTP', logLevel: 'log' },
    );
    expect(entry).toMatchObject({
      message: 'GET /v1/health 200',
      statusCode: 200,
      password: '***REDACTED***',
    });
  });
});
