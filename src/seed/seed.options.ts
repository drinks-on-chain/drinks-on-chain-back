/**
 * Opciones de la semilla leídas del entorno (0.10, OPS-09). Nunca hay
 * contraseñas por defecto: sin `SUPERADMIN_EMAIL`/`SUPERADMIN_PASSWORD` no se
 * toca el superusuario, y `SEED_DEMO=true` exige `SEED_DEMO_PASSWORD`.
 */

export interface SeedSuperadmin {
  email: string;
  password: string;
  fullName: string;
}

export interface SeedOptions {
  /** `null`: no se crea ni se actualiza el superusuario. */
  superadmin: SeedSuperadmin | null;
  /**
   * `null`: sin datos de demostración (`SEED_DEMO` distinto de `true`).
   * `totpSecret`: secreto TOTP (base32) del personal interno de demo inscrito
   * (`SEED_DEMO_TOTP_SECRET`); sin él quedan sin inscribir.
   */
  demo: { password: string; totpSecret: string | null } | null;
  /** Claves para cifrar los secretos TOTP como la API (`MfaCrypto`). */
  mfaKeys: { jwtSecret: string | null; mfaEncryptionKey: string | null };
  /** Coste de bcrypt (el de la API por defecto). */
  bcryptRounds: number;
}

export interface ParsedSeedOptions {
  options: SeedOptions;
  warnings: string[];
}

/** Configuración inválida: la semilla no se ejecuta. */
export class SeedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedConfigError';
  }
}

export const DEFAULT_BCRYPT_ROUNDS = 12;
export const MIN_SEED_PASSWORD_LENGTH = 10;
export const DEFAULT_SUPERADMIN_NAME = 'Superadministrador de la plataforma';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

/** Contraseña aceptable para la semilla: 10+ caracteres y no un marcador. */
export function assertSeedPassword(name: string, password: string): void {
  if (password.length < MIN_SEED_PASSWORD_LENGTH) {
    throw new SeedConfigError(
      `${name} debe tener al menos ${MIN_SEED_PASSWORD_LENGTH} caracteres`,
    );
  }
  if (/change-?me/i.test(password)) {
    throw new SeedConfigError(
      `${name} conserva el marcador de .env.example: genera una (openssl rand -hex 16)`,
    );
  }
}

function parseBoolean(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new SeedConfigError(`${name} debe ser true o false (es "${raw}")`);
}

export function seedOptionsFromEnv(env: NodeJS.ProcessEnv): ParsedSeedOptions {
  const warnings: string[] = [];

  const email = value(env, 'SUPERADMIN_EMAIL')?.toLowerCase();
  const password = env.SUPERADMIN_PASSWORD ?? '';
  let superadmin: SeedSuperadmin | null = null;
  if (email && password) {
    if (!EMAIL_PATTERN.test(email)) {
      throw new SeedConfigError(`SUPERADMIN_EMAIL no es un correo: "${email}"`);
    }
    if (/change-?me/i.test(email)) {
      throw new SeedConfigError(
        'SUPERADMIN_EMAIL conserva el marcador de .env.example',
      );
    }
    assertSeedPassword('SUPERADMIN_PASSWORD', password);
    superadmin = {
      email,
      password,
      fullName: value(env, 'SUPERADMIN_NAME') ?? DEFAULT_SUPERADMIN_NAME,
    };
  } else {
    warnings.push(
      'SUPERADMIN_EMAIL y SUPERADMIN_PASSWORD no están definidos: no se crea ni se actualiza el superusuario',
    );
  }

  let demo: SeedOptions['demo'] = null;
  if (parseBoolean('SEED_DEMO', value(env, 'SEED_DEMO'))) {
    const demoPassword = env.SEED_DEMO_PASSWORD ?? '';
    if (!demoPassword) {
      throw new SeedConfigError(
        'SEED_DEMO=true exige SEED_DEMO_PASSWORD (contraseña de las personas de demostración)',
      );
    }
    assertSeedPassword('SEED_DEMO_PASSWORD', demoPassword);
    const rawTotp = value(env, 'SEED_DEMO_TOTP_SECRET')
      ?.toUpperCase()
      .replace(/\s+/g, '');
    let totpSecret: string | null = null;
    if (rawTotp) {
      if (!/^[A-Z2-7]{16,}=*$/.test(rawTotp)) {
        throw new SeedConfigError(
          'SEED_DEMO_TOTP_SECRET debe ser base32 (A-Z, 2-7) de al menos 16 caracteres',
        );
      }
      if (!value(env, 'JWT_SECRET')) {
        throw new SeedConfigError(
          'SEED_DEMO_TOTP_SECRET necesita JWT_SECRET (y MFA_ENCRYPTION_KEY si la API la usa) para cifrarlo como la API',
        );
      }
      totpSecret = rawTotp;
    } else {
      warnings.push(
        'SEED_DEMO_TOTP_SECRET no está definido: el personal interno de demostración queda sin segundo factor y lo inscribirá al entrar',
      );
    }
    demo = { password: demoPassword, totpSecret };
  }

  return {
    options: {
      superadmin,
      demo,
      bcryptRounds: DEFAULT_BCRYPT_ROUNDS,
      mfaKeys: {
        jwtSecret: value(env, 'JWT_SECRET') ?? null,
        mfaEncryptionKey: value(env, 'MFA_ENCRYPTION_KEY') ?? null,
      },
    },
    warnings,
  };
}
