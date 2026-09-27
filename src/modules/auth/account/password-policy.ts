import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';

/**
 * Política de contraseñas nuevas (contrato O1 §1, IAM-05): mínimo 10
 * caracteres y fuera de la lista de contraseñas comunes. Siguiendo NIST SP
 * 800-63B no se exigen mezclas de símbolos ni caducidades: longitud y lista
 * de comunes. Tampoco se aceptan un solo carácter repetido ni secuencias
 * obvias (`1234567890`, `abcdefghij`), ni la propia dirección de correo.
 */
export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt solo usa los primeros 72 bytes; más de 128 caracteres no tiene sentido. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Contraseñas comunes de 10 o más caracteres (o que lo serían con relleno
 * trivial) de las listas públicas de filtraciones, más las obvias del
 * producto. Se comparan en minúsculas.
 */
const COMMON_PASSWORDS = new Set(
  [
    '1234567890',
    '12345678910',
    '123456789a',
    '1234567890a',
    '0123456789',
    '0987654321',
    '9876543210',
    '1111111111',
    '1234512345',
    '1q2w3e4r5t',
    '1q2w3e4r5t6y',
    'q1w2e3r4t5',
    'qwertyuiop',
    'qwertyuiop123',
    'qwerty1234',
    'qwerty12345',
    'qwerty123456',
    'asdfghjkl1',
    'asdfghjkl123',
    'zxcvbnm123',
    '1qaz2wsx3edc',
    'qazwsxedc123',
    'password12',
    'password123',
    'password1234',
    'password12345',
    'password!1',
    'passw0rd123',
    'p@ssw0rd123',
    'p@ssword123',
    'contraseña1',
    'contraseña12',
    'contraseña123',
    'contrasena1',
    'contrasena12',
    'contrasena123',
    'iloveyou12',
    'iloveyou123',
    'teamo12345',
    'teamo123456',
    'princess123',
    'football123',
    'baseball123',
    'sunshine123',
    'superman123',
    'starwars123',
    'welcome123',
    'welcome1234',
    'bienvenido1',
    'bienvenido123',
    'administrator',
    'administrador',
    'admin12345',
    'admin123456',
    'changeme123',
    'change-me123',
    'letmein123',
    'trustno1234',
    'abc1234567',
    'abcd123456',
    'abcdefghij',
    'abcdefghijk',
    'abcdefg123',
    'drinksonchain',
    'drinksonchain1',
    'drinksonchain123',
    'drinks-on-chain',
    'vendimia2026',
    'vendimia123',
    'bodega12345',
    'singani123',
    'demo123456',
    'demo1234567',
  ].map((p) => p.toLowerCase()),
);

const SEQUENCES = [
  '01234567890123456789',
  '98765432109876543210',
  'abcdefghijklmnopqrstuvwxyz',
  'zyxwvutsrqponmlkjihgfedcba',
  'qwertyuiopasdfghjklzxcvbnm',
];

function isSequence(value: string): boolean {
  const lower = value.toLowerCase();
  return SEQUENCES.some((seq) => seq.includes(lower));
}

/** Problemas de una contraseña nueva (lista vacía = aceptable). */
export function passwordProblems(
  password: unknown,
  context: { email?: string | null } = {},
): string[] {
  if (typeof password !== 'string') {
    return ['La contraseña es obligatoria'];
  }
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(
      `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(
      `La contraseña no puede tener más de ${PASSWORD_MAX_LENGTH} caracteres`,
    );
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    problems.push('Es una contraseña muy común: elige otra');
  } else if (password.length > 0 && /^(.)\1+$/.test(password)) {
    problems.push('No puede ser un mismo carácter repetido');
  } else if (password.length >= PASSWORD_MIN_LENGTH && isSequence(password)) {
    problems.push('No puede ser una secuencia de teclas o números');
  }
  const email = context.email?.trim().toLowerCase();
  if (email) {
    const local = email.split('@')[0];
    if (lower === email || (local.length >= 4 && lower === local)) {
      problems.push('No puede ser tu dirección de correo');
    }
  }
  return problems;
}

/** Lanza 422 `AUTH_WEAK_PASSWORD` con un detalle por problema en `field`. */
export function assertStrongPassword(
  password: unknown,
  field: string,
  context: { email?: string | null } = {},
): asserts password is string {
  const problems = passwordProblems(password, context);
  if (problems.length > 0) {
    const details: ErrorDetail[] = problems.map((message) => ({
      field,
      message,
    }));
    throw new AppException(
      422,
      ErrorCode.AUTH_WEAK_PASSWORD,
      'La contraseña no cumple la política: al menos 10 caracteres y que no sea común',
      details,
    );
  }
}
