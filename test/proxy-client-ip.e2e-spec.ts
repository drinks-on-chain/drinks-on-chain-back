import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomInt } from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import {
  PROXY_CLIENT_IP_HEADER,
  PROXY_SIGNATURE_HEADER,
  PROXY_TIMESTAMP_HEADER,
  signProxyRequest,
} from '../src/shared/middleware/proxy-client-ip';
import { deleteIdentityData } from './helpers/identity';

/**
 * IP real del cliente detrás del proxy de las apps (O1-OPS-1, contrato O1
 * §11 bis): con `PROXY_SHARED_SECRET`, la IP firmada en `X-DOC-Client-IP` es
 * la de la sesión y la de los límites; con firma caducada o alterada, o sin
 * secreto en el backend, se usa la de la conexión como hasta ahora.
 */

// Valores solo de prueba (no son secretos de ningún entorno)
const SECRET = 'e2e-proxy-secret-0123456789abcdef-new';
const OLD_SECRET = 'e2e-proxy-secret-0123456789abcdef-old';
const PASSWORD = 'Password123!';
const SIGNUP = '/v1/auth/signup';

/** IP de prueba única por ejecución (los contadores de Redis duran 1 h). */
const ipBase = `198.18.${randomInt(0, 255)}`;
let ipSeq = 1;
const nextIp = () => `${ipBase}.${ipSeq++}`;

function signed(
  ip: string,
  options: { secret?: string; method?: string; path?: string; ageS?: number },
) {
  const timestamp = String(Math.floor(Date.now() / 1000) - (options.ageS ?? 0));
  return {
    [PROXY_CLIENT_IP_HEADER]: ip,
    [PROXY_TIMESTAMP_HEADER]: timestamp,
    [PROXY_SIGNATURE_HEADER]: signProxyRequest(
      options.secret ?? SECRET,
      options.method ?? 'POST',
      options.path ?? SIGNUP,
      ip,
      timestamp,
    ),
  };
}

async function createApp(secret: string): Promise<INestApplication> {
  process.env.PROXY_SHARED_SECRET = secret;
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

describe('IP del cliente firmada por el proxy de las apps · O1-OPS-1 (e2e)', () => {
  const previousSecret = process.env.PROXY_SHARED_SECRET;
  const previousTrustProxy = process.env.TRUST_PROXY;
  let withSecret: INestApplication;
  let withoutSecret: INestApplication;
  let prisma: PrismaService;

  const run = `${Date.now()}`;
  let seq = 0;
  const email = () => `pip_${seq++}_${run}@test.bo`;

  beforeAll(async () => {
    // Conexión directa (sin nginx): la IP de la conexión es la del socket
    process.env.TRUST_PROXY = '';
    // Dos secretos: el nuevo y el anterior (rotación sin corte)
    withSecret = await createApp(`${SECRET},${OLD_SECRET}`);
    withoutSecret = await createApp('');
    prisma = withSecret.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await deleteIdentityData(prisma, { emailContains: run });
      await prisma.userWallet.deleteMany({
        where: { user: { email: { contains: run } } },
      });
      await prisma.user.deleteMany({ where: { email: { contains: run } } });
    }
    await withSecret?.close();
    await withoutSecret?.close();
    if (previousSecret === undefined) {
      delete process.env.PROXY_SHARED_SECRET;
    } else {
      process.env.PROXY_SHARED_SECRET = previousSecret;
    }
    if (previousTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = previousTrustProxy;
    }
  });

  /** Alta con las cabeceras dadas; devuelve la IP guardada en la sesión. */
  async function signupSessionIp(
    app: INestApplication,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const res = await request(app.getHttpServer())
      .post(SIGNUP)
      .set(headers)
      .send({ email: email(), password: PASSWORD, fullName: 'Proxy IP' })
      .expect(201);
    const session = await prisma.session.findFirst({
      where: { userId: res.body.data.user.id },
      select: { ip: true },
    });
    return session?.ip ?? null;
  }

  const isLoopback = (ip: string | null) =>
    ip !== null && /(^|:)127\.0\.0\.1$|^::1$/.test(ip);

  it('firma válida: la sesión guarda la IP del cliente', async () => {
    const ip = nextIp();
    expect(await signupSessionIp(withSecret, signed(ip, {}))).toBe(ip);
  });

  it('firma válida: la bitácora del login guarda la IP del cliente', async () => {
    const ip = nextIp();
    const path = '/v1/auth/login';
    await request(withSecret.getHttpServer())
      .post(path)
      .set(signed(ip, { path }))
      .send({ email: email(), password: 'Incorrecta123!' })
      .expect(401);
    const event = await prisma.auditEvent.findFirst({
      where: { action: 'AUTH_LOGIN_FAILED', sourceIp: ip },
      select: { id: true },
    });
    expect(event).not.toBeNull();
  });

  it('firma con el secreto anterior (rotación): también vale', async () => {
    const ip = nextIp();
    expect(
      await signupSessionIp(withSecret, signed(ip, { secret: OLD_SECRET })),
    ).toBe(ip);
  });

  it('firma caducada (más de 60 s): IP de la conexión', async () => {
    const ip = nextIp();
    const sessionIp = await signupSessionIp(
      withSecret,
      signed(ip, { ageS: 120 }),
    );
    expect(sessionIp).not.toBe(ip);
    expect(isLoopback(sessionIp)).toBe(true);
  });

  it('firma alterada (otra IP u otra ruta): IP de la conexión', async () => {
    const ip = nextIp();
    const tampered = {
      ...signed(ip, {}),
      [PROXY_CLIENT_IP_HEADER]: nextIp(),
    };
    expect(isLoopback(await signupSessionIp(withSecret, tampered))).toBe(true);
    expect(
      isLoopback(
        await signupSessionIp(withSecret, signed(ip, { path: '/v1/otra' })),
      ),
    ).toBe(true);
  });

  it('firma de un secreto desconocido: IP de la conexión', async () => {
    const ip = nextIp();
    const other = 'otro-secreto-que-no-conoce-el-backend-xx';
    expect(
      isLoopback(
        await signupSessionIp(withSecret, signed(ip, { secret: other })),
      ),
    ).toBe(true);
  });

  it('sin secreto en el backend: las cabeceras se ignoran y todo funciona', async () => {
    const ip = nextIp();
    expect(
      isLoopback(await signupSessionIp(withoutSecret, signed(ip, {}))),
    ).toBe(true);
  });

  it('el límite de peticiones cuenta por IP firmada, no por la del proxy', async () => {
    const limited = nextIp();
    const limit = Number(process.env.RATE_LIMIT_SIGNUP_PER_MINUTE ?? 5);
    const statuses: number[] = [];
    for (let i = 0; i <= limit; i++) {
      const res = await request(withSecret.getHttpServer())
        .post(SIGNUP)
        .set(signed(limited, {}))
        .send({ email: email(), password: PASSWORD, fullName: 'Límite' });
      statuses.push(res.status);
    }
    expect(statuses.at(-1)).toBe(429);
    // Otro usuario detrás del mismo proxy no hereda el límite
    const other = nextIp();
    expect(await signupSessionIp(withSecret, signed(other, {}))).toBe(other);
  });
});
