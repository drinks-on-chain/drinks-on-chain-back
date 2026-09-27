import { ArgumentMetadata } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { createAppValidationPipe } from '../app-validation.pipe';
import { ValidationException } from '../../exceptions/validation.exception';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PaginationQueryDto,
} from '../../dto/pagination-query.dto';

class LineDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}

class OrderDto {
  @IsString()
  @IsNotEmpty()
  email!: string;

  @ValidateNested({ each: true })
  @Type(() => LineDto)
  items!: LineDto[];
}

describe('createAppValidationPipe (contrato O0 §1-§2)', () => {
  const pipe = createAppValidationPipe();
  const query = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
    type: 'query',
    metatype,
  });
  const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
    type: 'body',
    metatype,
  });

  async function validationError(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<ValidationException> {
    try {
      await pipe.transform(value, metadata);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationException);
      return error as ValidationException;
    }
    throw new Error('Se esperaba un error de validación');
  }

  it('aplica limit=20 y offset=0 por defecto', async () => {
    const result = (await pipe.transform(
      {},
      query(PaginationQueryDto),
    )) as PaginationQueryDto;
    expect(result.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(result.offset).toBe(0);
  });

  it('convierte limit y offset de texto a número', async () => {
    const result = (await pipe.transform(
      { limit: '100', offset: '40' },
      query(PaginationQueryDto),
    )) as PaginationQueryDto;
    expect(result).toMatchObject({ limit: 100, offset: 40 });
  });

  it(`limit mayor que ${MAX_PAGE_LIMIT} → 422 VALIDATION_ERROR en limit`, async () => {
    const error = await validationError(
      { limit: '101' },
      query(PaginationQueryDto),
    );
    expect(error.statusCode).toBe(422);
    expect(error.errorCode).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([
      { field: 'limit', message: 'limit must not be greater than 100' },
    ]);
  });

  it('offset negativo y limit 0 → un detalle por campo', async () => {
    const error = await validationError(
      { limit: '0', offset: '-1' },
      query(PaginationQueryDto),
    );
    expect(error.details).toEqual([
      { field: 'limit', message: 'limit must not be less than 1' },
      { field: 'offset', message: 'offset must not be less than 0' },
    ]);
  });

  it('campos anidados con notación de puntos (items.0.quantity)', async () => {
    const error = await validationError(
      { email: '', items: [{ quantity: 0 }, { quantity: 2 }] },
      body(OrderDto),
    );
    expect(error.details).toEqual([
      { field: 'email', message: 'email should not be empty' },
      {
        field: 'items.0.quantity',
        message: 'quantity must not be less than 1',
      },
    ]);
  });

  it('campo no declarado → detalle con ese campo', async () => {
    const error = await validationError(
      { limit: '10', page: '2' },
      query(PaginationQueryDto),
    );
    expect(error.details).toEqual([
      { field: 'page', message: 'property page should not exist' },
    ]);
  });
});
