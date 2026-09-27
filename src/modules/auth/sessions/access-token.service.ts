import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import type { AccessTokenClaims } from '../interfaces/jwt-payload.interface';
import { SESSION_SETTINGS, SessionSettings } from './session.config';

export type AccessTokenInput = Omit<AccessTokenClaims, 'jti' | 'iat' | 'exp'>;

/** Emite y verifica los tokens de acceso (JWT HS256, 15 min). */
@Injectable()
export class AccessTokenService {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  get ttlSeconds(): number {
    return this.settings.accessTokenTtlSeconds;
  }

  async sign(claims: AccessTokenInput): Promise<string> {
    const payload: Omit<AccessTokenClaims, 'iat' | 'exp'> = {
      ...claims,
      jti: randomUUID(),
    };
    return this.jwt.signAsync(payload, {
      secret: this.secret,
      expiresIn: this.settings.accessTokenTtlSeconds,
    });
  }

  /**
   * Verifica firma y caducidad. Con `ignoreExpiration` sirve para identificar
   * la sesión de un acceso ya caducado (logout).
   */
  async verify(
    token: string,
    options: { ignoreExpiration?: boolean } = {},
  ): Promise<AccessTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims>(token, {
      secret: this.secret,
      algorithms: ['HS256'],
      ignoreExpiration: options.ignoreExpiration ?? false,
    });
  }
}
