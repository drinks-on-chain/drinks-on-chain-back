import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { GlobalExceptionFilter } from '../global-exception.filter';
import { DomainException } from '../../exceptions/app.exception';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  it('should format DomainException into ApiErrorResponse with code and 422 status', () => {
    const mockJson = jest.fn();
    const mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({
          url: '/v1/bottling-batches/123/release',
          method: 'POST',
        }),
      }),
    } as unknown as ArgumentsHost;

    const exception = new DomainException(
      'BOTTLING_BATCH_NO_LAB_ANALYSIS',
      'Conforming lab analysis required',
    );

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(422);
    expect(mockJson).toHaveBeenCalledWith(
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
    const mockJson = jest.fn();
    const mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/v1/unknown-route', method: 'GET' }),
      }),
    } as unknown as ArgumentsHost;

    const exception = new NotFoundException('Route not found');

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 404,
        path: '/v1/unknown-route',
        error: expect.objectContaining({
          code: 'NOT_FOUND',
        }),
      }),
    );
  });
});
