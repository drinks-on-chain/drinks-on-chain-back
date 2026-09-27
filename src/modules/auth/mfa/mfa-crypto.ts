import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const HKDF_SALT = 'drinks-on-chain/mfa';

function deriveKey(material: string, info: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(material, 'utf8'), HKDF_SALT, info, 32),
  );
}

function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

interface KeyEntry {
  id: string;
  key: Buffer;
}

/**
 * Cifrado de los secretos TOTP en la base (PLT-05) con AES-256-GCM.
 *
 * - Clave: HKDF-SHA256 de `MFA_ENCRYPTION_KEY` (≥ 32 caracteres; genera una con
 *   `openssl rand -base64 32`). Sin ella se deriva de `JWT_SECRET` (con otra
 *   etiqueta HKDF) y se avisa al arrancar: el entorno funciona, pero cambiar
 *   `JWT_SECRET` dejaría ilegibles los secretos (habría que restablecer el
 *   segundo factor de cada persona).
 * - Formato: `v1.<idClave>.<iv>.<etiqueta>.<cifrado>` (base64url). El id de la
 *   clave permite pasar de la derivada a una propia sin perder nada: lo
 *   cifrado con la derivada se sigue leyendo y se vuelve a cifrar con la nueva
 *   la próxima vez que la persona pasa el TOTP (`needsReencrypt`).
 * - Los códigos de recuperación se guardan como HMAC-SHA256 con una clave
 *   derivada de la misma (no son reversibles).
 */
@Injectable()
export class MfaCrypto implements OnModuleInit {
  private readonly logger = new Logger(MfaCrypto.name);
  private readonly primary: KeyEntry;
  private readonly keys = new Map<string, Buffer>();
  private readonly hmacKeys: Buffer[];
  readonly usesFallbackKey: boolean;

  constructor(config: ConfigService) {
    const configured = config.get<string>('MFA_ENCRYPTION_KEY')?.trim();
    const jwtSecret = config.getOrThrow<string>('JWT_SECRET');
    const fallback = deriveKey(jwtSecret, 'totp-secret-fallback');
    this.usesFallbackKey = !configured;
    const primaryKey = configured
      ? deriveKey(configured, 'totp-secret')
      : fallback;
    this.primary = { id: keyId(primaryKey), key: primaryKey };
    this.keys.set(this.primary.id, primaryKey);
    this.keys.set(keyId(fallback), fallback);
    const fallbackHmac = deriveKey(jwtSecret, 'recovery-codes');
    this.hmacKeys = configured
      ? [deriveKey(configured, 'recovery-codes'), fallbackHmac]
      : [fallbackHmac];
  }

  onModuleInit(): void {
    if (this.usesFallbackKey) {
      this.logger.warn(
        'MFA_ENCRYPTION_KEY no está definida: los secretos TOTP se cifran con una clave derivada de JWT_SECRET. Define MFA_ENCRYPTION_KEY (openssl rand -base64 32) en el entorno; lo ya cifrado se sigue leyendo.',
      );
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.primary.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.primary.id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      data.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new Error('Secreto TOTP con formato desconocido');
    }
    const [, id, iv, tag, data] = parts;
    const key = this.keys.get(id);
    if (!key) {
      throw new Error(
        `Secreto TOTP cifrado con otra clave (${id}): hay que restablecer el segundo factor`,
      );
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** ¿Está cifrado con una clave que no es la actual? */
  needsReencrypt(payload: string): boolean {
    return payload.split('.')[1] !== this.primary.id;
  }

  /** HMAC de un código de recuperación normalizado (con la clave actual). */
  hashRecoveryCode(code: string): string {
    return createHmac('sha256', this.hmacKeys[0]).update(code).digest('hex');
  }

  /** HMAC con la clave actual y con la derivada (códigos guardados antes de definir la clave). */
  recoveryCodeHashCandidates(code: string): string[] {
    return this.hmacKeys.map((key) =>
      createHmac('sha256', key).update(code).digest('hex'),
    );
  }
}
