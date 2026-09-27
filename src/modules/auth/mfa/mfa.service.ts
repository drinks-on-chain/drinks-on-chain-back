import { Injectable, Logger } from '@nestjs/common';
import { MfaChallenge, Prisma, User, UserMfa } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import {
  AppException,
  RetryAfterException,
} from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isPlausibleToken,
} from '@shared/security/opaque-token';
import { MailService } from '@modules/mail/mail.service';
import { PLATFORM_ORGANIZATION_ID } from '@modules/organizations/organization.constants';
import { MfaCrypto } from './mfa-crypto';
import {
  RECOVERY_CODES_COUNT,
  TOTP_CODE_PATTERN,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  totpUri,
  verifyTotp,
} from './totp';

/** Vida del reto (`mfaToken`). */
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
/** Códigos incorrectos seguidos antes del bloqueo temporal. */
export const MFA_MAX_FAILURES = 5;
/** Bloqueo tras los fallos seguidos (y `Retry-After`). */
export const MFA_LOCK_SECONDS = 5 * 60;

export interface MfaChallengeBody {
  mfa: { required: true; enrolled: boolean; mfaToken: string };
}

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

/** Reto superado: la persona y la organización que debe quedar activa. */
export interface MfaPassed {
  userId: string;
  organizationId: string | null;
  /** Solo al confirmar la inscripción: se muestran una vez. */
  recoveryCodes?: string[];
}

type ChallengeWithUser = MfaChallenge & {
  user: Pick<User, 'id' | 'email' | 'fullName' | 'isActive'> & {
    mfa: UserMfa | null;
  };
};

function tokenInvalid(): AppException {
  return new AppException(
    401,
    ErrorCode.AUTH_MFA_TOKEN_INVALID,
    'El reto de segundo factor caducó o no es válido: inicia sesión de nuevo',
  );
}

export function isMfaEnrolled(
  mfa: Pick<UserMfa, 'secretEncrypted' | 'enrolledAt'> | null | undefined,
): boolean {
  return Boolean(mfa?.secretEncrypted && mfa.enrolledAt);
}

/**
 * Segundo factor TOTP del personal de plataforma (PLT-05, contrato O1 §1).
 *
 * El login de una persona con membresía de plataforma no abre sesión: emite
 * un reto (`mfaToken`, 5 min, un solo uso; solo se guarda su hash). Con él,
 * `verify` (código TOTP o de recuperación) o `enroll` + `confirmEnrollment`
 * (primera vez) lo superan y el `AuthService` abre la sesión marcada con el
 * segundo factor. Cinco códigos incorrectos seguidos anulan el reto, bloquean
 * el segundo factor 5 minutos (429) y avisan por correo.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MfaCrypto,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  /** ¿Tiene el segundo factor inscrito? */
  async isEnrolled(userId: string): Promise<boolean> {
    const mfa = await this.prisma.userMfa.findUnique({ where: { userId } });
    return isMfaEnrolled(mfa);
  }

  /** Personas con el segundo factor inscrito (de una lista). */
  async enrolledUserIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.userMfa.findMany({
      where: {
        userId: { in: userIds },
        secretEncrypted: { not: null },
        enrolledAt: { not: null },
      },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  /**
   * Reto nuevo (login o invitación de plataforma aceptada). `organizationId`:
   * la organización que queda activa al superarlo.
   */
  async startChallenge(
    user: Pick<User, 'id' | 'email'>,
    options: {
      client: ClientMeta;
      organizationId?: string | null;
      tx?: Prisma.TransactionClient;
    },
  ): Promise<MfaChallengeBody> {
    const token = generateOpaqueToken();
    const write = async (tx: Prisma.TransactionClient) => {
      const mfa = await tx.userMfa.findUnique({ where: { userId: user.id } });
      await tx.mfaChallenge.create({
        data: {
          userId: user.id,
          tokenHash: hashOpaqueToken(token),
          organizationId: options.organizationId ?? null,
          expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000),
          ip: options.client.ip?.slice(0, 64) ?? null,
          userAgent: options.client.userAgent?.slice(0, 300) ?? null,
        },
      });
      const enrolled = isMfaEnrolled(mfa);
      await this.audit.record(tx, {
        action: AuditAction.AUTH_MFA_CHALLENGED,
        resource: { type: 'user', id: user.id },
        actor: { userId: user.id },
        organizationId: PLATFORM_ORGANIZATION_ID,
        after: { enrolled },
      });
      return enrolled;
    };
    const enrolled = options.tx
      ? await write(options.tx)
      : await this.prisma.$transaction(write, AUDIT_TX_OPTIONS);
    return { mfa: { required: true, enrolled, mfaToken: token } };
  }

  /** `POST /auth/mfa/enroll`: secreto nuevo (el mismo si se repite con el mismo reto). */
  async enroll(
    mfaToken: string,
  ): Promise<{ otpauthUrl: string; secret: string }> {
    const challenge = await this.findLiveChallenge(mfaToken);
    this.assertNotLocked(challenge.user.mfa);
    if (isMfaEnrolled(challenge.user.mfa)) {
      throw new AppException(
        409,
        ErrorCode.AUTH_MFA_ALREADY_ENROLLED,
        'El segundo factor ya está inscrito: usa /v1/auth/mfa/verify',
      );
    }
    let secret: string;
    if (challenge.pendingSecretEncrypted) {
      secret = this.crypto.decrypt(challenge.pendingSecretEncrypted);
    } else {
      secret = newTotpSecret();
      await this.prisma.mfaChallenge.update({
        where: { id: challenge.id },
        data: { pendingSecretEncrypted: this.crypto.encrypt(secret) },
      });
    }
    return { otpauthUrl: totpUri(secret, challenge.user.email), secret };
  }

  /** `POST /auth/mfa/enroll/confirm`: primer código correcto → inscrito + 10 códigos. */
  async confirmEnrollment(mfaToken: string, code: string): Promise<MfaPassed> {
    const challenge = await this.findLiveChallenge(mfaToken);
    const { user } = challenge;
    this.assertNotLocked(user.mfa);
    if (isMfaEnrolled(user.mfa)) {
      throw new AppException(
        409,
        ErrorCode.AUTH_MFA_ALREADY_ENROLLED,
        'El segundo factor ya está inscrito: usa /v1/auth/mfa/verify',
      );
    }
    if (!challenge.pendingSecretEncrypted) {
      throw new AppException(
        409,
        ErrorCode.AUTH_MFA_ENROLLMENT_NOT_STARTED,
        'Primero hay que pedir el secreto con /v1/auth/mfa/enroll',
      );
    }
    const secret = this.crypto.decrypt(challenge.pendingSecretEncrypted);
    const step = verifyTotp(secret, code.trim(), null);
    if (step === null) {
      return this.failure(challenge);
    }

    const recoveryCodes = Array.from(
      { length: RECOVERY_CODES_COUNT },
      newRecoveryCode,
    );
    await this.prisma.$transaction(async (tx) => {
      await this.consume(tx, challenge);
      await tx.userMfa.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          secretEncrypted: this.crypto.encrypt(secret),
          enrolledAt: new Date(),
          lastUsedStep: step,
        },
        update: {
          secretEncrypted: this.crypto.encrypt(secret),
          enrolledAt: new Date(),
          lastUsedStep: step,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({
          userId: user.id,
          codeHash: this.crypto.hashRecoveryCode(normalizeRecoveryCode(c)!),
        })),
      });
      await this.audit.record(tx, {
        action: AuditAction.MFA_ENROLLED,
        resource: { type: 'user', id: user.id },
        actor: { userId: user.id },
        organizationId: PLATFORM_ORGANIZATION_ID,
      });
      await this.recordLogin(tx, user, 'TOTP');
    }, AUDIT_TX_OPTIONS);
    return {
      userId: user.id,
      organizationId: challenge.organizationId,
      recoveryCodes,
    };
  }

  /** `POST /auth/mfa/verify`: código TOTP de 6 dígitos o código de recuperación. */
  async verify(mfaToken: string, code: string): Promise<MfaPassed> {
    const challenge = await this.findLiveChallenge(mfaToken);
    const { user } = challenge;
    const mfa = user.mfa;
    this.assertNotLocked(mfa);
    if (!mfa || !isMfaEnrolled(mfa)) {
      throw new AppException(
        409,
        ErrorCode.AUTH_MFA_NOT_ENROLLED,
        'El segundo factor no está inscrito: usa /v1/auth/mfa/enroll',
      );
    }

    const trimmed = code.trim();
    if (TOTP_CODE_PATTERN.test(trimmed)) {
      const encrypted = mfa.secretEncrypted!;
      const secret = this.crypto.decrypt(encrypted);
      const step = verifyTotp(secret, trimmed, mfa.lastUsedStep ?? null);
      if (step === null) {
        return this.failure(challenge);
      }
      await this.prisma.$transaction(async (tx) => {
        await this.consume(tx, challenge);
        await tx.userMfa.update({
          where: { userId: user.id },
          data: {
            lastUsedStep: step,
            failedAttempts: 0,
            // Rotación perezosa a la clave actual
            ...(this.crypto.needsReencrypt(encrypted)
              ? { secretEncrypted: this.crypto.encrypt(secret) }
              : {}),
          },
        });
        await this.recordLogin(tx, user, 'TOTP');
      }, AUDIT_TX_OPTIONS);
      return { userId: user.id, organizationId: challenge.organizationId };
    }

    const normalized = normalizeRecoveryCode(trimmed);
    const candidates = normalized
      ? this.crypto.recoveryCodeHashCandidates(normalized)
      : [];
    const recovery = candidates.length
      ? await this.prisma.mfaRecoveryCode.findFirst({
          where: {
            userId: user.id,
            usedAt: null,
            codeHash: { in: candidates },
          },
        })
      : null;
    if (!recovery) {
      return this.failure(challenge);
    }
    await this.prisma.$transaction(async (tx) => {
      // Un solo uso aunque lleguen dos peticiones a la vez
      const used = await tx.mfaRecoveryCode.updateMany({
        where: { id: recovery.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (used.count === 0) {
        throw this.invalidCode();
      }
      await this.consume(tx, challenge);
      await tx.userMfa.update({
        where: { userId: user.id },
        data: { failedAttempts: 0 },
      });
      const remaining = await tx.mfaRecoveryCode.count({
        where: { userId: user.id, usedAt: null },
      });
      await this.audit.record(tx, {
        action: AuditAction.MFA_RECOVERY_CODE_USED,
        resource: { type: 'user', id: user.id },
        actor: { userId: user.id },
        organizationId: PLATFORM_ORGANIZATION_ID,
        after: { remaining },
      });
      await this.recordLogin(tx, user, 'RECOVERY_CODE');
    }, AUDIT_TX_OPTIONS);
    return { userId: user.id, organizationId: challenge.organizationId };
  }

  /**
   * Restablece el segundo factor (lo pide administración, PLT-05): borra el
   * secreto y los códigos. En la transacción de quien llama (que registra la
   * bitácora y revoca las sesiones).
   */
  async reset(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const current = await tx.userMfa.findUnique({ where: { userId } });
    const wasEnrolled = isMfaEnrolled(current);
    if (current) {
      await tx.userMfa.update({
        where: { userId },
        data: {
          secretEncrypted: null,
          enrolledAt: null,
          lastUsedStep: null,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
    }
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaChallenge.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return wasEnrolled;
  }

  /**
   * Inscribe un secreto conocido sin códigos de recuperación (solo la semilla
   * de demostración, con `SEED_DEMO_TOTP_SECRET`).
   */
  encryptSecret(secret: string): string {
    return this.crypto.encrypt(secret);
  }

  // ─── Internos ──────────────────────────────────────────────────────────

  private async findLiveChallenge(
    mfaToken: string,
  ): Promise<ChallengeWithUser> {
    if (!isPlausibleToken(mfaToken)) {
      throw tokenInvalid();
    }
    const challenge = await this.prisma.mfaChallenge.findUnique({
      where: { tokenHash: hashOpaqueToken(mfaToken) },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            isActive: true,
            mfa: true,
          },
        },
      },
    });
    if (
      !challenge ||
      challenge.usedAt ||
      challenge.expiresAt.getTime() <= Date.now() ||
      !challenge.user.isActive
    ) {
      throw tokenInvalid();
    }
    return challenge;
  }

  private assertNotLocked(mfa: UserMfa | null): void {
    const until = mfa?.lockedUntil?.getTime() ?? 0;
    if (until > Date.now()) {
      throw new RetryAfterException(
        ErrorCode.AUTH_TOO_MANY_ATTEMPTS,
        'Demasiados códigos incorrectos: vuelve a intentarlo en unos minutos',
        Math.max(1, Math.ceil((until - Date.now()) / 1000)),
      );
    }
  }

  /** Marca el reto como usado (una sola vez aunque lleguen dos peticiones). */
  private async consume(
    tx: Prisma.TransactionClient,
    challenge: MfaChallenge,
  ): Promise<void> {
    const updated = await tx.mfaChallenge.updateMany({
      where: { id: challenge.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (updated.count === 0) {
      throw tokenInvalid();
    }
  }

  private invalidCode(): AppException {
    return new AppException(
      401,
      ErrorCode.AUTH_MFA_INVALID_CODE,
      'El código no es válido',
      [{ field: 'code', message: 'El código no es válido' }],
    );
  }

  /**
   * Código incorrecto: cuenta el fallo (confirmado aunque la petición falle);
   * al quinto seguido anula el reto, bloquea 5 min, avisa por correo y 429.
   */
  private async failure(challenge: ChallengeWithUser): Promise<never> {
    const { user } = challenge;
    const locked = await this.prisma.$transaction(async (tx) => {
      const mfa = await tx.userMfa.upsert({
        where: { userId: user.id },
        create: { userId: user.id, failedAttempts: 1 },
        update: { failedAttempts: { increment: 1 } },
      });
      const lock = mfa.failedAttempts >= MFA_MAX_FAILURES;
      if (lock) {
        await tx.userMfa.update({
          where: { userId: user.id },
          data: {
            failedAttempts: 0,
            lockedUntil: new Date(Date.now() + MFA_LOCK_SECONDS * 1000),
          },
        });
        await tx.mfaChallenge.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        await this.mail.enqueue(tx, {
          template: 'segundo-factor-intentos-fallidos',
          to: user.email,
          variables: {
            nombre: user.fullName,
            intentos: MFA_MAX_FAILURES,
            minutos: MFA_LOCK_SECONDS / 60,
          },
        });
      }
      await this.audit.record(tx, {
        action: lock ? AuditAction.MFA_LOCKED : AuditAction.MFA_FAILED,
        resource: { type: 'user', id: user.id },
        actor: { userId: user.id },
        organizationId: PLATFORM_ORGANIZATION_ID,
        after: { failures: lock ? MFA_MAX_FAILURES : mfa.failedAttempts },
      });
      return lock;
    }, AUDIT_TX_OPTIONS);
    if (locked) {
      this.logger.warn(
        `Segundo factor de ${user.id} bloqueado tras ${MFA_MAX_FAILURES} códigos incorrectos`,
      );
      throw new RetryAfterException(
        ErrorCode.AUTH_TOO_MANY_ATTEMPTS,
        'Demasiados códigos incorrectos: inicia sesión de nuevo en unos minutos',
        MFA_LOCK_SECONDS,
      );
    }
    throw this.invalidCode();
  }

  private async recordLogin(
    tx: Prisma.TransactionClient,
    user: Pick<User, 'id' | 'email' | 'fullName'>,
    method: 'TOTP' | 'RECOVERY_CODE',
  ): Promise<void> {
    await this.audit.record(tx, {
      action: AuditAction.AUTH_LOGIN_SUCCEEDED,
      resource: { type: 'user', id: user.id },
      actor: { userId: user.id, fullName: user.fullName },
      organizationId: null,
      after: { email: user.email, mfa: method },
    });
  }
}
