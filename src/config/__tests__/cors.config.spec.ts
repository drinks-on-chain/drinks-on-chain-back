import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import {
  buildCorsOptions,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  DEFAULT_DEV_ORIGINS,
  parseCorsAllowedOrigins,
} from '../cors.config';

describe('cors.config', () => {
  describe('parseCorsAllowedOrigins', () => {
    it('splits, trims and deduplicates the list', () => {
      expect(
        parseCorsAllowedOrigins(
          ' http://localhost:3002 ,https://erp.example.com/,,http://localhost:3002',
          'development',
        ),
      ).toEqual(['http://localhost:3002', 'https://erp.example.com']);
    });

    it('uses the local defaults when empty outside production', () => {
      expect(parseCorsAllowedOrigins(undefined, 'development')).toEqual([
        ...DEFAULT_DEV_ORIGINS,
      ]);
      expect(parseCorsAllowedOrigins('  ', 'test')).toEqual([
        ...DEFAULT_DEV_ORIGINS,
      ]);
    });

    it('fails when empty in production', () => {
      expect(() => parseCorsAllowedOrigins('', 'production')).toThrow(
        /obligatorio en producción/,
      );
    });

    it.each(['production', 'development'])(
      'rejects wildcards (%s)',
      (nodeEnv) => {
        expect(() => parseCorsAllowedOrigins('*', nodeEnv)).toThrow(
          /no admite comodines/,
        );
        expect(() =>
          parseCorsAllowedOrigins('https://*.vercel.app', nodeEnv),
        ).toThrow(/no admite comodines/);
      },
    );

    it('rejects entries that are not http(s) origins', () => {
      expect(() => parseCorsAllowedOrigins('erp.example.com', 'test')).toThrow(
        /inválido/,
      );
      expect(() =>
        parseCorsAllowedOrigins('ftp://example.com', 'test'),
      ).toThrow(/http\(s\)/);
      expect(() =>
        parseCorsAllowedOrigins('https://example.com/app', 'test'),
      ).toThrow(/sin ruta/);
    });
  });

  describe('buildCorsOptions', () => {
    it('uses the exact list (never reflects the request origin)', () => {
      const options = buildCorsOptions(['https://erp.example.com']);
      expect(options.origin).toEqual(['https://erp.example.com']);
      expect(options.origin).not.toBe(true);
      expect(options.credentials).toBe(true);
    });

    it('declares the headers of the O0 contract', () => {
      const options = buildCorsOptions(['https://erp.example.com']);
      expect(options.allowedHeaders).toEqual(
        expect.arrayContaining([
          'Authorization',
          'Content-Type',
          'X-Correlation-ID',
          'Idempotency-Key',
        ]),
      );
      expect(options.exposedHeaders).toEqual(
        expect.arrayContaining(['X-Correlation-ID', 'Retry-After']),
      );
      expect(CORS_ALLOWED_HEADERS).toContain('Idempotency-Key');
      expect(CORS_EXPOSED_HEADERS).toContain('Retry-After');
    });
  });

  describe('HTTP behaviour', () => {
    @Controller('ping')
    class PingController {
      @Get()
      ping(): string {
        return 'pong';
      }
    }

    let app: INestApplication;
    const allowed = 'https://erp.example.com';

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [PingController],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      app.enableCors(buildCorsOptions([allowed]));
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers the preflight of an allowed origin', async () => {
      const res = await request(app.getHttpServer())
        .options('/ping')
        .set('Origin', allowed)
        .set('Access-Control-Request-Method', 'POST')
        .set(
          'Access-Control-Request-Headers',
          'authorization,content-type,idempotency-key',
        )
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBe(allowed);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-headers']).toContain(
        'Idempotency-Key',
      );
    });

    it('exposes the correlation, retry and download headers', async () => {
      const res = await request(app.getHttpServer())
        .get('/ping')
        .set('Origin', allowed)
        .expect(200);

      expect(res.headers['access-control-expose-headers']).toBe(
        'X-Correlation-ID,Retry-After,Content-Disposition',
      );
    });

    it('never reflects an unknown origin', async () => {
      const res = await request(app.getHttpServer())
        .get('/ping')
        .set('Origin', 'https://evil.example.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
