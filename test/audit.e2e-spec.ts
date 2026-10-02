import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { AuditService } from '../src/shared/audit/audit.service';
import { deleteIdentityData } from './helpers/identity';
import { wineryWithOwner } from './helpers/staff-session';
import { resetLoopbackLoginLocks } from './helpers/login-locks';

/**
 * Bitácora con Postgres real (AUD-01, AUD-02): misma transacción que la
 * operación, cadena sin huecos con escrituras simultáneas, solo inserción
 * impuesta por la base y verificación que detecta manipulaciones.
 */
describe('Bitácora (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;

  const run = `aud-${Date.now()}`;
  const email = `audit_${run}@test.bo`;
  const password = 'Password123!';
  let wineryId: string | undefined;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    await resetLoopbackLoginLocks(app);
    prisma = app.get(PrismaService);
    audit = app.get(AuditService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.outboxEvent.deleteMany({
        where: { correlationId: { startsWith: run } },
      });
      await deleteIdentityData(prisma, {
        emailContains: email,
        wineryIds: wineryId ? [wineryId] : [],
      });
      await prisma.userWallet.deleteMany({ where: { user: { email } } });
      await prisma.wineryMember.deleteMany({ where: { user: { email } } });
      if (wineryId) {
        await prisma.userWallet.deleteMany({ where: { wineryId } });
        await prisma.winery.deleteMany({ where: { id: wineryId } });
      }
      await prisma.user.deleteMany({ where: { email } });
    }
    await app?.close();
  });

  it('escrituras simultáneas: seq consecutivos, sin repetir, y cadena válida', async () => {
    const writes = Array.from({ length: 12 }, (_, i) =>
      audit.recordStandalone({
        action: 'E2E_CONCURRENT_WRITE',
        resource: { type: 'e2e', id: `${i}` },
        correlationId: `${run}-c${i}`,
        after: { i },
      }),
    );
    const rows = await Promise.all(writes);
    const seqs = rows.map((r) => Number(r.seq)).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(12);

    // Cada una enlaza con la entrada inmediatamente anterior de la tabla
    for (const row of rows) {
      const previous = await prisma.auditEvent.findUnique({
        where: { seq: row.seq - BigInt(1) },
        select: { hash: true },
      });
      expect(row.prevHash).toBe(previous?.hash ?? null);
    }

    const result = await audit.verifyChain(seqs[0], seqs[seqs.length - 1]);
    expect(result).toMatchObject({ valid: true, firstBrokenSeq: null });
    expect(result.checked).toBeGreaterThanOrEqual(12);
    await expect(audit.verifyChain()).resolves.toMatchObject({ valid: true });
  });

  it('si la operación se revierte, la entrada no existe', async () => {
    const correlationId = `${run}-rollback`;
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.record(tx, {
          action: 'E2E_ROLLED_BACK',
          resource: { type: 'e2e', id: 'rb' },
          correlationId,
        });
        throw new Error('fallo después de registrar');
      }),
    ).rejects.toThrow('fallo después de registrar');

    await expect(
      prisma.auditEvent.count({ where: { correlationId } }),
    ).resolves.toBe(0);
    await expect(audit.verifyChain()).resolves.toMatchObject({ valid: true });
  });

  it('la base rechaza UPDATE, DELETE y TRUNCATE', async () => {
    const row = await audit.recordStandalone({
      action: 'E2E_IMMUTABLE',
      resource: { type: 'e2e', id: 'imm' },
      correlationId: `${run}-imm`,
    });

    await expect(
      prisma.auditEvent.update({
        where: { id: row.id },
        data: { reason: 'cambiado' },
      }),
    ).rejects.toThrow(/solo inserción/);
    await expect(
      prisma.auditEvent.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/solo inserción/);
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM audit_events'),
    ).rejects.toThrow(/solo inserción/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE audit_events'),
    ).rejects.toThrow(/solo inserción/);

    await expect(
      prisma.auditEvent.findUnique({ where: { id: row.id } }),
    ).resolves.toMatchObject({ reason: null });
  });

  it('verifyChain detecta una entrada manipulada (con el trigger desactivado a propósito)', async () => {
    const row = await audit.recordStandalone({
      action: 'E2E_TAMPER_TARGET',
      resource: { type: 'e2e', id: 'tamper' },
      correlationId: `${run}-tamper`,
      after: { amount: 10 },
    });
    const seq = Number(row.seq);

    // Simula a alguien con permisos de superusuario que salta el trigger
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete',
      );
      await tx.$executeRawUnsafe(
        `UPDATE audit_events SET after = '{"amount": 1000}'::jsonb WHERE id = '${row.id}'`,
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete',
      );
    });

    try {
      await expect(audit.verifyChain(seq, seq)).resolves.toEqual({
        valid: false,
        checked: 0,
        firstBrokenSeq: seq,
      });
    } finally {
      // Deja la cadena como estaba para el resto de pruebas
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete',
        );
        await tx.$executeRawUnsafe(
          `UPDATE audit_events SET after = '{"amount": 10}'::jsonb WHERE id = '${row.id}'`,
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete',
        );
      });
    }
    await expect(audit.verifyChain(seq, seq)).resolves.toMatchObject({
      valid: true,
    });
  });

  it('una escritura por HTTP deja actor, app de origen y correlación', async () => {
    const owned = await wineryWithOwner(app, {
      name: `Bodega ${run}`,
      taxId: `AUD${Date.now().toString().slice(-9)}`,
      email,
      password,
      fullName: 'Auditada E2E',
    });
    wineryId = owned.wineryId;
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const token = login.body.data.tokens.accessToken as string;

    await request(app.getHttpServer())
      .patch('/v1/organizations/current')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Client-App', 'ERP')
      .set('X-Correlation-ID', `${run}-winery`)
      .send({ publicStory: `Historia ${run}` })
      .expect(200);

    const entry = await prisma.auditEvent.findFirst({
      where: { action: 'WINERY_UPDATED', resourceId: wineryId },
    });
    expect(entry).toMatchObject({
      actorUserId: owned.ownerId,
      actorFullName: 'Auditada E2E',
      sourceApp: 'ERP',
      correlationId: `${run}-winery`,
      organizationId: wineryId,
      resourceType: 'winery',
    });
  });

  it('registra el inicio de sesión correcto y el fallido, sin la contraseña', async () => {
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Correlation-ID', `${run}-login-ok`)
      .send({ email, password })
      .expect(200);
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Correlation-ID', `${run}-login-ko`)
      .send({ email, password: 'Incorrecta123!' })
      .expect(401);

    const ok = await prisma.auditEvent.findFirst({
      where: { correlationId: `${run}-login-ok` },
    });
    const ko = await prisma.auditEvent.findFirst({
      where: { correlationId: `${run}-login-ko` },
    });
    expect(ok).toMatchObject({ action: 'AUTH_LOGIN_SUCCEEDED' });
    expect(ok?.actorUserId).toBeTruthy();
    expect(ko).toMatchObject({
      action: 'AUTH_LOGIN_FAILED',
      actorUserId: null,
      after: { email, status: 401 },
    });
    const stored = JSON.stringify([ok, ko], (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(stored).not.toContain('Incorrecta123!');
    expect(stored).not.toContain(password);
  });
});
