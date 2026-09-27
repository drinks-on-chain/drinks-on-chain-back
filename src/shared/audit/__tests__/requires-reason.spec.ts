import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createAppValidationPipe } from '@shared/pipes/app-validation.pipe';
import { GlobalExceptionFilter } from '@shared/filters/global-exception.filter';
import {
  OptionalReasonProperty,
  ReasonProperty,
  RequiresReason,
  assertReason,
  normalizeReason,
} from '../requires-reason';

class RequiredReasonDto {
  @ReasonProperty()
  reason!: string;
}

class OptionalReasonDto {
  @OptionalReasonProperty()
  reason?: string;
}

/** Persona de la petición, como la deja el guard de acceso. */
let organizationType: string | null = 'PLATFORM';

@Controller('reason')
class ReasonController {
  @Post('always')
  @RequiresReason()
  always(@Body() dto: RequiredReasonDto) {
    return dto;
  }

  @Post('platform')
  @RequiresReason({ when: 'platform' })
  platform(@Body() dto: OptionalReasonDto) {
    return dto;
  }
}

describe('Motivo obligatorio (AUD-05)', () => {
  describe('normalizeReason / assertReason', () => {
    it('recorta y acepta 3–500 caracteres', () => {
      expect(normalizeReason('  ok!  ')).toBe('ok!');
      expect(normalizeReason('a'.repeat(500))).toHaveLength(500);
    });

    it.each([undefined, null, 42, '', '  ab  ', 'a'.repeat(501)])(
      'rechaza %p',
      (value) => {
        expect(normalizeReason(value)).toBeNull();
        expect(() => assertReason(value)).toThrow(
          expect.objectContaining({
            statusCode: 422,
            errorCode: 'VALIDATION_ERROR',
            details: [expect.objectContaining({ field: 'reason' })],
          }),
        );
      },
    );

    it('usa el campo indicado en details', () => {
      expect(() => assertReason('', 'decision.reason')).toThrow(
        expect.objectContaining({
          details: [expect.objectContaining({ field: 'decision.reason' })],
        }),
      );
    });
  });

  describe('decoradores de DTO', () => {
    it('ReasonProperty: obligatorio y recortado', () => {
      const ok = plainToInstance(RequiredReasonDto, { reason: '  motivo  ' });
      expect(validateSync(ok)).toHaveLength(0);
      expect(ok.reason).toBe('motivo');
      expect(validateSync(plainToInstance(RequiredReasonDto, {}))).toHaveLength(
        1,
      );
    });

    it('OptionalReasonProperty: puede faltar, pero si llega cumple las reglas', () => {
      expect(validateSync(plainToInstance(OptionalReasonDto, {}))).toHaveLength(
        0,
      );
      expect(
        validateSync(plainToInstance(OptionalReasonDto, { reason: 'ab' })),
      ).toHaveLength(1);
    });
  });

  describe('@RequiresReason() en una ruta', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [ReasonController],
      }).compile();
      app = moduleRef.createNestApplication();
      app.use(
        (
          req: { user?: { organizationType: string | null } },
          _res: unknown,
          next: () => void,
        ) => {
          req.user = { organizationType };
          next();
        },
      );
      app.useGlobalPipes(createAppValidationPipe());
      app.useGlobalFilters(new GlobalExceptionFilter());
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it('sin motivo → 422 con details[{ field: reason }]', async () => {
      const res = await request(app.getHttpServer())
        .post('/reason/always')
        .send({})
        .expect(422);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'reason', message: expect.any(String) }],
      });
    });

    it('con motivo pasa, recortado', async () => {
      const res = await request(app.getHttpServer())
        .post('/reason/always')
        .send({ reason: '  Pedido por la bodega  ' })
        .expect(201);
      expect(res.body).toEqual({ reason: 'Pedido por la bodega' });
    });

    it("when: 'platform' lo exige solo a la plataforma", async () => {
      organizationType = 'PLATFORM';
      await request(app.getHttpServer())
        .post('/reason/platform')
        .send({})
        .expect(422);
      organizationType = 'WINERY';
      await request(app.getHttpServer())
        .post('/reason/platform')
        .send({})
        .expect(201);
      organizationType = 'PLATFORM';
    });
  });
});
