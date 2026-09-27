import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn().mockResolvedValue(undefined),
        $disconnect: jest.fn().mockResolvedValue(undefined),
        ping: jest.fn().mockResolvedValue(true),
      })
      .compile();

    app = moduleFixture.createNestApplication();

    // Misma configuración que main.ts (versionado, validación 422, envoltorio)
    configureApp(app);

    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /v1/health should return standard ApiSuccessResponse format', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/health')
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('statusCode', 200);
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('path', '/v1/health');
    expect(response.body).toHaveProperty('data');
    expect(response.body.data).toHaveProperty('status');
    expect(response.body.data).toHaveProperty('database');
    expect(response.body.data).toHaveProperty('redis');
    expect(response.body.data).toHaveProperty('uptime');
  });
});
