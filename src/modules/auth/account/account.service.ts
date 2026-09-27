import { Injectable, Logger } from '@nestjs/common';
import { AccountTokenPurposeEnum, Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { CaptchaService } from '@shared/captcha/captcha.service';
import { getRequestContext } from '@shared/context/request-context';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isPlausibleToken,
} from '@shared/security/opaque-token';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { MailService } from '@modules/mail/mail.service';
import { AppLinks, LinkApp, linkAppForClient } from '@modules/mail/app-links';
import {
  RevocationReason,
  SessionsService,
} from '../sessions/sessions.service';
import { LoginAttemptsService } from '../rate-limit/login-attempts.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  ResendVerificationDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from '../dto/account.dto';
import { assertStrongPassword, passwordProblems } from './password-policy';

/** Vida del enlace de recuperación (contrato O1 §1). */
export const PASSWORD_RESET_TTL_MINUTES = 60;
/** Vida del enlace de verificación del correo. */
export const EMAIL_VERIFICATION_TTL_HOURS = 48;
/** Como mucho tantos enlaces por persona y ventana; el resto, 202 sin correo. */
export const ACCOUNT_MAIL_BURST = 3;
export const ACCOUNT_MAIL_WINDOW_MINUTES = 15;
export const PASSWORD_BCRYPT_ROUNDS = 12;

type AccountUser = Pick<User, 'id' | 'email' | 'fullName'>;

export interface ClientMeta {
  ip: string | null;
}

/**
 * Cuenta (IAM-05, IAM-06; contrato O1 §1): recuperación y cambio de
 * contraseña, verificación del correo. Los enlaces son de un solo uso, solo
 * se guarda su hash y los correos salen por la cola en la misma transacción.
 * Las respuestas públicas no revelan si un correo tiene cuenta.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly links: AppLinks,
    private readonly captcha: CaptchaService,
    private readonly sessions: SessionsService,
    private readonly loginAttempts: LoginAttemptsService,
  ) {}

  /** `POST /auth/forgot-password`: siempre 202; correo solo si hay cuenta activa. */
  async forgotPassword(dto: ForgotPasswordDto, client: ClientMeta) {
    await this.captcha.verify(dto.captchaToken, client.ip);
    if (dto.website?.trim()) {
      this.logger.warn('forgot-password con el campo trampa relleno: ignorado');
      return;
    }
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });
    if (!user || !user.isActive) {
      return;
    }
    if (await this.tooManyRecent(user.id, 'PASSWORD_RESET')) {
      this.logger.warn(
        `Recuperación de ${user.id}: demasiados enlaces seguidos`,
      );
      return;
    }
    const app = linkAppForClient(getRequestContext()?.clientApp);
    await this.prisma.$transaction(async (tx) => {
      await this.issuePasswordReset(tx, user, app, client.ip);
      await this.audit.record(tx, {
        action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
        resource: { type: 'user', id: user.id },
        actor: null,
        organizationId: null,
      });
    }, AUDIT_TX_OPTIONS);
  }

  /**
   * Crea un enlace de recuperación (anula los anteriores sin usar) y encola el
   * correo, en la transacción `tx`. Lo usa también la plataforma
   * (`POST /platform/users/{userId}/send-password-reset`).
   */
  async issuePasswordReset(
    tx: Prisma.TransactionClient,
    user: AccountUser,
    app: LinkApp,
    requestedIp: string | null,
  ): Promise<void> {
    const token = await this.createToken(
      tx,
      user,
      AccountTokenPurposeEnum.PASSWORD_RESET,
      PASSWORD_RESET_TTL_MINUTES * 60,
      requestedIp,
    );
    await this.mail.enqueue(tx, {
      template: 'recuperar-contrasena',
      to: user.email,
      variables: {
        nombre: user.fullName,
        enlace: this.links.passwordReset(app, token),
        minutos: PASSWORD_RESET_TTL_MINUTES,
      },
    });
  }

  /** `POST /auth/reset-password`: contraseña nueva y todas las sesiones cerradas. */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const record = await this.findLiveToken(
      dto.token,
      AccountTokenPurposeEnum.PASSWORD_RESET,
    );
    if (!record) {
      throw new AppException(
        422,
        ErrorCode.AUTH_RESET_TOKEN_INVALID,
        'El enlace de recuperación no es válido o caducó: pide otro',
        [{ field: 'token', message: 'Enlace no válido o caducado' }],
      );
    }
    const { user } = record;
    assertStrongPassword(dto.password, 'password', { email: user.email });
    const passwordHash = await bcrypt.hash(
      dto.password,
      PASSWORD_BCRYPT_ROUNDS,
    );

    await this.prisma.$transaction(async (tx) => {
      await this.useToken(tx, record.id, ErrorCode.AUTH_RESET_TOKEN_INVALID);
      await tx.accountToken.updateMany({
        where: {
          userId: user.id,
          purpose: AccountTokenPurposeEnum.PASSWORD_RESET,
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          // El enlace llegó a ese buzón: el correo queda comprobado
          ...(user.emailVerifiedAt === null && record.email === user.email
            ? { emailVerifiedAt: new Date() }
            : {}),
        },
      });
      await this.mail.enqueue(tx, {
        template: 'contrasena-cambiada',
        to: user.email,
        variables: { nombre: user.fullName },
      });
      await this.audit.record(tx, {
        action: AuditAction.USER_PASSWORD_RESET,
        resource: { type: 'user', id: user.id },
        actor: { userId: user.id },
        organizationId: null,
      });
    }, AUDIT_TX_OPTIONS);

    const revoked = await this.sessions.revokeAllForUser(
      user.id,
      RevocationReason.PASSWORD_RESET,
    );
    await this.loginAttempts.recordSuccess(user.email);
    this.logger.log(
      `Contraseña de ${user.id} restablecida; ${revoked} sesiones revocadas`,
    );
  }

  /** `POST /auth/verify-email`. */
  async verifyEmail(dto: VerifyEmailDto): Promise<void> {
    const record = await this.findLiveToken(
      dto.token,
      AccountTokenPurposeEnum.EMAIL_VERIFICATION,
    );
    if (!record || record.email !== record.user.email) {
      throw this.emailTokenInvalid();
    }
    await this.prisma.$transaction(async (tx) => {
      await this.useToken(tx, record.id, ErrorCode.AUTH_EMAIL_TOKEN_INVALID);
      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: record.user.emailVerifiedAt ?? new Date() },
      });
      await this.audit.record(tx, {
        action: AuditAction.USER_EMAIL_VERIFIED,
        resource: { type: 'user', id: record.userId },
        actor: { userId: record.userId },
        organizationId: null,
        after: { email: record.email },
      });
    }, AUDIT_TX_OPTIONS);
  }

  /** `POST /auth/resend-verification`: siempre 202; correo si falta verificarlo. */
  async resendVerification(dto: ResendVerificationDto, client: ClientMeta) {
    await this.captcha.verify(dto.captchaToken, client.ip);
    if (dto.website?.trim()) {
      this.logger.warn(
        'resend-verification con el campo trampa relleno: ignorado',
      );
      return;
    }
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });
    if (!user || !user.isActive || user.emailVerifiedAt) {
      return;
    }
    if (await this.tooManyRecent(user.id, 'EMAIL_VERIFICATION')) {
      return;
    }
    const app = linkAppForClient(getRequestContext()?.clientApp);
    await this.prisma.$transaction(async (tx) => {
      await this.issueEmailVerification(tx, user, app, client.ip);
      await this.audit.record(tx, {
        action: AuditAction.USER_EMAIL_VERIFICATION_SENT,
        resource: { type: 'user', id: user.id },
        actor: null,
        organizationId: null,
      });
    }, AUDIT_TX_OPTIONS);
  }

  /** Enlace de verificación del correo (y su correo) en la transacción `tx`. */
  async issueEmailVerification(
    tx: Prisma.TransactionClient,
    user: AccountUser,
    app: LinkApp,
    requestedIp: string | null,
  ): Promise<void> {
    const token = await this.createToken(
      tx,
      user,
      AccountTokenPurposeEnum.EMAIL_VERIFICATION,
      EMAIL_VERIFICATION_TTL_HOURS * 3600,
      requestedIp,
    );
    await this.mail.enqueue(tx, {
      template: 'verificar-correo',
      to: user.email,
      variables: {
        nombre: user.fullName,
        enlace: this.links.emailVerify(app, token),
        horas: EMAIL_VERIFICATION_TTL_HOURS,
      },
    });
  }

  /** `POST /users/me/password`: cierra las demás sesiones de la persona. */
  async changePassword(
    principal: AuthenticatedUser,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.id },
    });
    const currentOk = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!currentOk) {
      throw new AppException(
        422,
        ErrorCode.AUTH_INVALID_CURRENT_PASSWORD,
        'La contraseña actual no es correcta',
        [{ field: 'currentPassword', message: 'No es correcta' }],
      );
    }
    const problems = passwordProblems(dto.newPassword, { email: user.email });
    if (dto.newPassword === dto.currentPassword) {
      problems.push('La contraseña nueva debe ser distinta de la actual');
    }
    if (problems.length > 0) {
      throw new AppException(
        422,
        ErrorCode.AUTH_WEAK_PASSWORD,
        'La contraseña no cumple la política: al menos 10 caracteres y que no sea común',
        problems.map((message) => ({ field: 'newPassword', message })),
      );
    }
    const passwordHash = await bcrypt.hash(
      dto.newPassword,
      PASSWORD_BCRYPT_ROUNDS,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      await this.mail.enqueue(tx, {
        template: 'contrasena-cambiada',
        to: user.email,
        variables: { nombre: user.fullName },
      });
      await this.audit.record(tx, {
        action: AuditAction.USER_PASSWORD_CHANGED,
        resource: { type: 'user', id: user.id },
        organizationId: null,
      });
    }, AUDIT_TX_OPTIONS);
    const revoked = await this.sessions.revokeAllForUser(
      user.id,
      RevocationReason.PASSWORD_CHANGED,
      principal.sessionId,
    );
    this.logger.log(
      `Contraseña de ${user.id} cambiada; ${revoked} sesiones más revocadas`,
    );
  }

  // ─── Internos ──────────────────────────────────────────────────────────

  private emailTokenInvalid(): AppException {
    return new AppException(
      422,
      ErrorCode.AUTH_EMAIL_TOKEN_INVALID,
      'El enlace de verificación no es válido, ya se usó o caducó',
      [{ field: 'token', message: 'Enlace no válido o caducado' }],
    );
  }

  private async tooManyRecent(
    userId: string,
    purpose: `${AccountTokenPurposeEnum}`,
  ): Promise<boolean> {
    const since = new Date(
      Date.now() - ACCOUNT_MAIL_WINDOW_MINUTES * 60 * 1000,
    );
    const recent = await this.prisma.accountToken.count({
      where: { userId, purpose, createdAt: { gte: since } },
    });
    return recent >= ACCOUNT_MAIL_BURST;
  }

  private async createToken(
    tx: Prisma.TransactionClient,
    user: AccountUser,
    purpose: AccountTokenPurposeEnum,
    ttlSeconds: number,
    requestedIp: string | null,
  ): Promise<string> {
    const token = generateOpaqueToken();
    // Solo vale el último enlace de cada tipo
    await tx.accountToken.updateMany({
      where: { userId: user.id, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.accountToken.create({
      data: {
        userId: user.id,
        purpose,
        tokenHash: hashOpaqueToken(token),
        email: user.email,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        requestedIp: requestedIp?.slice(0, 64) ?? null,
      },
    });
    return token;
  }

  private async findLiveToken(token: string, purpose: AccountTokenPurposeEnum) {
    if (!isPlausibleToken(token)) return null;
    const record = await this.prisma.accountToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      include: { user: true },
    });
    if (
      !record ||
      record.purpose !== purpose ||
      record.usedAt ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    return record;
  }

  /** Marca el enlace como usado (una sola vez aunque lleguen dos peticiones). */
  private async useToken(
    tx: Prisma.TransactionClient,
    id: string,
    code: string,
  ): Promise<void> {
    const used = await tx.accountToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count === 0) {
      throw new AppException(422, code, 'El enlace ya se usó', [
        { field: 'token', message: 'El enlace ya se usó' },
      ]);
    }
  }
}
