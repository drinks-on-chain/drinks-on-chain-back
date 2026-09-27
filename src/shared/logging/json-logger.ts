import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { getRequestContext } from '@shared/context/request-context';
import { sanitizeLogData } from '@shared/utils/log-sanitizer.util';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Logger JSON de una línea por entrada (docs/rules/05 §4, docs-back/03 §15).
 *
 * Añade a cada entrada el proceso (`service`), la fecha ISO 8601 y, del
 * contexto asíncrono en curso (petición HTTP o trabajo de la cola), el
 * `correlationId`, la sesión (`sid`), la organización activa (`org`), la
 * persona (`userId`) y la app de origen (`app`), para seguir una operación de
 * la API al worker.
 *
 * Si el mensaje es un objeto plano, sus campos van al primer nivel (saneados)
 * y su `message` es el texto: `logger.log({ message: 'x', durationMs: 3 })`.
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
    let fields: Record<string, unknown> = {};
    if (isPlainObject(message)) {
      const sanitized = sanitizeLogData(message) as Record<string, unknown>;
      const { message: text, ...rest } = sanitized;
      fields = rest;
      base.message = text ?? '';
    }
    const ctx = getRequestContext();
    return {
      timestamp: new Date(timestamp).toISOString(),
      ...base,
      ...fields,
      service: this.service,
      ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
      ...(ctx?.sessionId ? { sid: ctx.sessionId } : {}),
      ...(ctx?.organizationId ? { org: ctx.organizationId } : {}),
      ...(ctx?.userId ? { userId: ctx.userId } : {}),
      ...(ctx?.clientApp && ctx.clientApp !== 'WORKER'
        ? { app: ctx.clientApp }
        : {}),
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
