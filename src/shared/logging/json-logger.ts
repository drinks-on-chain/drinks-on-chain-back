import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { CorrelationIdMiddleware } from '@shared/middleware/correlation-id.middleware';

/**
 * Logger JSON de una línea por entrada (docs/rules/05 §4, docs-back/03 §15).
 *
 * Añade a cada entrada el proceso (`service`), la fecha ISO 8601 y el
 * `correlationId` del contexto asíncrono en curso (petición HTTP o trabajo de
 * la cola), para seguir una operación de la API al worker.
 */
export class JsonLogger extends ConsoleLogger {
  constructor(
    private readonly service: string,
    logLevels?: LogLevel[],
  ) {
    super({ json: true, colors: false, logLevels });
  }

  /** Entrada que se escribe (expuesta para las pruebas). */
  buildEntry(
    message: unknown,
    options: {
      context: string;
      logLevel: LogLevel;
      errorStack?: unknown;
    },
  ): Record<string, unknown> {
    const { timestamp, ...base } = this.getJsonLogObject(message, options);
    const correlationId = CorrelationIdMiddleware.getCorrelationId();
    return {
      timestamp: new Date(timestamp).toISOString(),
      ...base,
      service: this.service,
      ...(correlationId ? { correlationId } : {}),
    };
  }

  protected printAsJson(
    message: unknown,
    options: {
      context: string;
      logLevel: LogLevel;
      writeStreamType?: 'stdout' | 'stderr';
      errorStack?: unknown;
    },
  ): void {
    const line = JSON.stringify(this.buildEntry(message, options), (k, v) =>
      this.stringifyReplacer(k, v),
    );
    process[options.writeStreamType ?? 'stdout'].write(`${line}\n`);
  }
}
