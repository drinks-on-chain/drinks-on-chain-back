import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  GlobalExceptionFilter,
  normalizeErrorDetails,
} from '../global-exception.filter';
import { AppException, DomainException } from '../../exceptions/app.exception';
import { ValidationException } from '../../exceptions/validation.exception';

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  headers: Record<string, string>;
  getHeader: (name: string) => string | undefined;
  setHeader: (name: string, value: string) => void;
}

function createHost(url: string, method = 'GET') {
  const json = jest.fn();
  const response: MockResponse = {
    headers: {},
    json,
    status: jest.fn(),
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
  };
  response.status.mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url, method }),
    }),
  } as unknown as ArgumentsHost;
  return { host, response, json };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  it('should format DomainException into ApiErrorResponse with code and 422 status', () => {
    const { host, response, json } = createHost(
      '/v1/bottling-batches/123/release',
      'POST',
    );

    filter.catch(
      new DomainException(
        'BOTTLING_BATCH_NO_LAB_ANALYSIS',
        'Conforming lab analysis required',
      ),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 422,
        path: '/v1/bottling-batches/123/release',
        error: {
          code: 'BOTTLING_BATCH_NO_LAB_ANALYSIS',
          message: 'Conforming lab analysis required',
          details: null,
        },
      }),
    );
  });

  it('should format standard NestJS HttpException into ApiErrorResponse', () => {
    const { host, response, json } = createHost('/v1/unknown-route');

    filter.catch(new NotFoundException('Route not found'), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 404,
        path: '/v1/unknown-route',
        error: {
          code: 'NOT_FOUND',
          message: 'Route not found',
          details: null,
        },
      }),
    );
  });

  it('ValidationException → 422 VALIDATION_ERROR con details por campo', () => {
    const { host, response, json } = createHost('/v1/terroirs?limit=500');

    filter.catch(
      new ValidationException([
        { field: 'limit', message: 'limit must not be greater than 100' },
      ]),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: [
        { field: 'limit', message: 'limit must not be greater than 100' },
      ],
    });
  });

  it('una lista de mensajes sueltos (pipe sin la fábrica común) → 422 con field null', () => {
    const { host, response, json } = createHost('/v1/x', 'POST');

    filter.catch(
      new BadRequestException(['name must be a string', 'age must be an int']),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: [
        { field: null, message: 'name must be a string' },
        { field: null, message: 'age must be an int' },
      ],
    });
  });

  it('una regla de negocio de NestJS (422) usa UNPROCESSABLE_ENTITY', () => {
    const { host, json } = createHost('/v1/bottling', 'POST');

    filter.catch(new UnprocessableEntityException('Reposo < 180 días'), host);

    expect(json.mock.calls[0][0].error).toEqual({
      code: 'UNPROCESSABLE_ENTITY',
      message: 'Reposo < 180 días',
      details: null,
    });
  });

  it('nunca expone details que no sean [{ field, message }]', () => {
    const { host, json } = createHost('/v1/nft', 'POST');

    filter.catch(
      new AppException(502, 'STELLAR_TX_FAILED', 'Mint failed', {
        txHash: 'abc',
        contractError: 'internal',
      }),
      host,
    );

    expect(json.mock.calls[0][0].error.details).toBeNull();
  });

  it('429 → TOO_MANY_REQUESTS y siempre con Retry-After', () => {
    const { host, response, json } = createHost('/v1/auth/login', 'POST');

    filter.catch(new ThrottlerException(), host);

    expect(response.status).toHaveBeenCalledWith(429);
    expect(json.mock.calls[0][0].error.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBe(
      String(DEFAULT_RETRY_AFTER_SECONDS),
    );
  });

  it('429 conserva el Retry-After que puso el ThrottlerGuard', () => {
    const { host, response } = createHost('/v1/auth/login', 'POST');
    response.setHeader('Retry-After', '17');

    filter.catch(new ThrottlerException(), host);

    expect(response.headers['retry-after']).toBe('17');
  });

  it('error no controlado → 500 INTERNAL_ERROR sin detalles', () => {
    const { host, response, json } = createHost('/v1/x');

    filter.catch(new Error('db exploded'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal server error occurred',
      details: null,
    });
  });
});

describe('normalizeErrorDetails', () => {
  it('conserva { field, message } y convierte field vacío en null', () => {
    expect(
      normalizeErrorDetails([
        { field: 'a.b', message: 'm1' },
        { field: '', message: 'm2' },
        { message: 'm3' },
      ]),
    ).toEqual([
      { field: 'a.b', message: 'm1' },
      { field: null, message: 'm2' },
      { field: null, message: 'm3' },
    ]);
  });

  it('null, objetos y listas vacías → null', () => {
    expect(normalizeErrorDetails(null)).toBeNull();
    expect(normalizeErrorDetails(undefined)).toBeNull();
    expect(normalizeErrorDetails({ field: 'x', message: 'y' })).toBeNull();
    expect(normalizeErrorDetails([])).toBeNull();
    expect(normalizeErrorDetails([42])).toBeNull();
  });
});
