import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { ResponseTransformInterceptor } from '../response-transform.interceptor';

describe('ResponseTransformInterceptor', () => {
  let interceptor: ResponseTransformInterceptor<unknown>;

  beforeEach(() => {
    interceptor = new ResponseTransformInterceptor();
  });

  it('should transform plain payload into ApiSuccessResponse structure', (done) => {
    const mockRequest = { url: '/v1/test-endpoint' };
    const mockResponse = { statusCode: 200 };

    const mockExecutionContext = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => of({ message: 'Hello Drinks on Chain' }),
    };

    interceptor
      .intercept(mockExecutionContext, mockCallHandler)
      .subscribe((result) => {
        expect(result.success).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(result.path).toBe('/v1/test-endpoint');
        expect(result.data).toEqual({ message: 'Hello Drinks on Chain' });
        expect(result.timestamp).toBeDefined();
        done();
      });
  });
});
