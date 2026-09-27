import { JsonLogger } from '../json-logger';
import { runWithCorrelationId } from '../correlation';

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
});
