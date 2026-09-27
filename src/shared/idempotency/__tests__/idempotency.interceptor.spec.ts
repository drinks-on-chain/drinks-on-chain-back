import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import { AppException } from '../../exceptions/app.exception';
import {
  IDEMPOTENT_METADATA,
  IdempotencyInterceptor,
  type IdempotentOptions,
} from '../idempotency.interceptor';
import {
  IDEMPOTENCY_LOCK_TTL_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
  InMemoryIdempotencyStore,
  buildIdempotencyStorageKey,
  fingerprintBody,
} from '../idempotency.store';

const KEY = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

interface FakeRequest {
  method: string;
  originalUrl: string;
  url: string;
  body: unknown;
  user?: { id: string };
  headers: Record<string, string>;
  header(name: string): string | undefined;
}

function createRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  const headers = overrides.headers ?? {};
  return {
    method: 'POST',
    originalUrl: '/v1/terroirs',
    url: '/v1/terroirs',
    body: { parcelName: 'Cuartel Norte', altitudeMasl: 1850 },
    user: { id: 'user-1' },
    ...overrides,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

function createResponse() {
  return {
    statusCode: 201,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
  };
}

function createContext(
  request: FakeRequest,
  response = createResponse(),
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function handler() {
  /* marcador para los metadatos del reflector */
}

describe('IdempotencyInterceptor (contrato O0 §3)', () => {
  let store: InMemoryIdempotencyStore;
  let options: IdempotentOptions;
  let interceptor: IdempotencyInterceptor;
  let executions: number;

  const next = (result: unknown = { id: 'terroir-1' }): CallHandler => ({
    handle: () =>
      new Observable((subscriber) => {
        executions++;
        subscriber.next(result);
        subscriber.complete();
      }),
  });

  const run = async (
    request: FakeRequest,
    callHandler: CallHandler = next(),
    response = createResponse(),
  ) =>
    firstValueFrom(
      await interceptor.intercept(
        createContext(request, response),
        callHandler,
      ),
    );

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    options = {};
    executions = 0;
    const reflector = {
      get: (key: string) => (key === IDEMPOTENT_METADATA ? options : undefined),
    } as unknown as Reflector;
    interceptor = new IdempotencyInterceptor(store, reflector);
  });

  it('sin cabecera la petición pasa tal cual y no guarda nada', async () => {
    await expect(run(createRequest())).resolves.toEqual({ id: 'terroir-1' });
    await expect(run(createRequest())).resolves.toEqual({ id: 'terroir-1' });
    expect(executions).toBe(2);
  });

  it('sin cabecera y con required → 422 IDEMPOTENCY_KEY_REQUIRED', async () => {
    options = { required: true };
    await expect(run(createRequest())).rejects.toMatchObject({
      statusCode: 422,
      errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
      details: [{ field: 'Idempotency-Key', message: expect.any(String) }],
    });
    expect(executions).toBe(0);
  });

  it('una clave que no es UUID → 422 IDEMPOTENCY_KEY_INVALID', async () => {
    await expect(
      run(createRequest({ headers: { 'idempotency-key': 'not-a-uuid' } })),
    ).rejects.toMatchObject({
      statusCode: 422,
      errorCode: 'IDEMPOTENCY_KEY_INVALID',
      details: [
        { field: 'Idempotency-Key', message: 'Idempotency-Key must be a UUID' },
      ],
    });
    expect(executions).toBe(0);
  });

  it('misma clave y mismo cuerpo → misma respuesta sin repetir la operación', async () => {
    const headers = { 'idempotency-key': KEY };
    const first = await run(
      createRequest({ headers }),
      next({ id: 'terroir-1', createdAt: new Date('2026-09-27T10:00:00Z') }),
    );
    const replayResponse = createResponse();
    replayResponse.statusCode = 200;
    const second = await run(
      createRequest({
        headers,
        // Mismo cuerpo con las claves en otro orden
        body: { altitudeMasl: 1850, parcelName: 'Cuartel Norte' },
      }),
      next({ id: 'terroir-2' }),
      replayResponse,
    );

    expect(executions).toBe(1);
    expect(second).toEqual(JSON.parse(JSON.stringify(first)));
    expect(replayResponse.statusCode).toBe(201);
    expect(replayResponse.headers['idempotent-replayed']).toBe('true');
  });

  it('guarda la respuesta 24 h con clave por persona, ruta y clave', async () => {
    const setSpy = jest.spyOn(store, 'complete');
    await run(createRequest({ headers: { 'idempotency-key': KEY } }));

    const storageKey = buildIdempotencyStorageKey({
      userId: 'user-1',
      method: 'POST',
      path: '/v1/terroirs',
      key: KEY,
    });
    expect(setSpy).toHaveBeenCalledWith(
      storageKey,
      expect.objectContaining({
        state: 'completed',
        statusCode: 201,
        body: { id: 'terroir-1' },
        fingerprint: fingerprintBody({
          parcelName: 'Cuartel Norte',
          altitudeMasl: 1850,
        }),
      }),
      IDEMPOTENCY_TTL_SECONDS,
    );
  });

  it('misma clave con otro cuerpo → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const headers = { 'idempotency-key': KEY };
    await run(createRequest({ headers }));
    await expect(
      run(createRequest({ headers, body: { parcelName: 'Otra' } })),
    ).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(executions).toBe(1);
  });

  it('misma clave mientras la primera sigue en curso → 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const headers = { 'idempotency-key': KEY };
    let release!: () => void;
    const slow: CallHandler = {
      handle: () =>
        new Observable((subscriber) => {
          executions++;
          release = () => {
            subscriber.next({ id: 'terroir-1' });
            subscriber.complete();
          };
        }),
    };

    const firstPromise = run(createRequest({ headers }), slow);
    // Deja que la primera reserve la clave
    await new Promise((resolve) => setImmediate(resolve));

    await expect(run(createRequest({ headers }))).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'IDEMPOTENCY_IN_PROGRESS',
    });

    release();
    await expect(firstPromise).resolves.toEqual({ id: 'terroir-1' });
    await expect(run(createRequest({ headers }))).resolves.toEqual({
      id: 'terroir-1',
    });
    expect(executions).toBe(1);
  });

  it('la misma clave en otra ruta o de otra persona es otra operación', async () => {
    const headers = { 'idempotency-key': KEY };
    await run(createRequest({ headers }));
    await run(
      createRequest({
        headers,
        originalUrl: '/v1/harvest-batches',
        url: '/v1/harvest-batches',
      }),
    );
    await run(createRequest({ headers, user: { id: 'user-2' } }));
    expect(executions).toBe(3);
  });

  it('si la operación falla libera la clave para reintentar', async () => {
    const headers = { 'idempotency-key': KEY };
    const failing: CallHandler = {
      handle: () => {
        executions++;
        return throwError(() => new AppException(422, 'X', 'falló'));
      },
    };
    await expect(run(createRequest({ headers }), failing)).rejects.toThrow(
      'falló',
    );
    await expect(run(createRequest({ headers }))).resolves.toEqual({
      id: 'terroir-1',
    });
    expect(executions).toBe(2);
  });

  it('la reserva caduca sola si el proceso muere a mitad', async () => {
    let now = Date.parse('2026-09-27T10:00:00Z');
    store = new InMemoryIdempotencyStore(() => now);
    interceptor = new IdempotencyInterceptor(store, {
      get: () => options,
    } as unknown as Reflector);
    const storageKey = buildIdempotencyStorageKey({
      userId: 'user-1',
      method: 'POST',
      path: '/v1/terroirs',
      key: KEY,
    });
    await store.acquire(
      storageKey,
      fingerprintBody(createRequest().body),
      'dead-lock',
      IDEMPOTENCY_LOCK_TTL_SECONDS,
    );
    const headers = { 'idempotency-key': KEY };

    await expect(run(createRequest({ headers }))).rejects.toMatchObject({
      errorCode: 'IDEMPOTENCY_IN_PROGRESS',
    });
    now += (IDEMPOTENCY_LOCK_TTL_SECONDS + 1) * 1000;
    await expect(run(createRequest({ headers }))).resolves.toEqual({
      id: 'terroir-1',
    });
  });

  it('almacén caído → 503 IDEMPOTENCY_STORE_UNAVAILABLE sin ejecutar', async () => {
    jest.spyOn(store, 'acquire').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      run(createRequest({ headers: { 'idempotency-key': KEY } })),
    ).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'IDEMPOTENCY_STORE_UNAVAILABLE',
    });
    expect(executions).toBe(0);
  });

  it('si no puede guardar la respuesta, responde igual', async () => {
    jest.spyOn(store, 'complete').mockRejectedValue(new Error('timeout'));
    await expect(
      run(createRequest({ headers: { 'idempotency-key': KEY } })),
    ).resolves.toEqual({ id: 'terroir-1' });
  });

  it('una respuesta sin cuerpo se guarda como null', async () => {
    const headers = { 'idempotency-key': KEY };
    await run(createRequest({ headers }), { handle: () => of(undefined) });
    await expect(run(createRequest({ headers }))).resolves.toBeNull();
  });
});

describe('fingerprintBody', () => {
  it('no depende del orden de las claves ni de los undefined', () => {
    expect(fingerprintBody({ a: 1, b: { c: [1, 2], d: undefined } })).toBe(
      fingerprintBody({ b: { c: [1, 2] }, a: 1 }),
    );
  });

  it('distingue valores y orden de las listas', () => {
    expect(fingerprintBody({ a: [1, 2] })).not.toBe(
      fingerprintBody({ a: [2, 1] }),
    );
    expect(fingerprintBody({ a: '1' })).not.toBe(fingerprintBody({ a: 1 }));
  });
});
