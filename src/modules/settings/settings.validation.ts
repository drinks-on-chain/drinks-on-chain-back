import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type { SettingCatalogEntry, SettingValue } from './settings.types';

/** Nivel en el que se escribe: estándar general o ajuste de una bodega. */
export type SettingScope = 'GLOBAL' | 'WINERY';

export interface ValidateOptions {
  scope: SettingScope;
  /** Excepción legal autorizada (solo ajustes por bodega, ADMIN y motivo). */
  legalException?: boolean;
}

export interface ValidatedSetting {
  value: SettingValue;
  /** El valor es más laxo que el mínimo legal (y se autorizó la excepción). */
  belowLegalMinimum: boolean;
}

/** Tamaño máximo de un valor `OBJECT` o `LIST` serializado. */
const MAX_JSON_BYTES = 10_000;
const MAX_STRING_LENGTH = 1000;
const MAX_LIST_ITEMS = 100;

function invalid(message: string): ValidationException {
  return new ValidationException([{ field: 'value', message }], message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * `true` si `value` es más laxo que el mínimo legal (A-31): un número menor
 * que el piso, o una lista con algún elemento fuera de la lista legal.
 */
export function isLaxerThanLegalMinimum(
  entry: SettingCatalogEntry,
  value: SettingValue,
): boolean {
  const legal = entry.legalMinimum;
  if (legal === undefined || legal === null) return false;
  if (typeof legal === 'number') {
    return typeof value === 'number' && value < legal;
  }
  if (Array.isArray(value)) {
    const allowed = new Set(legal.map((v) => v.toLowerCase()));
    return value.some((item) => !allowed.has(String(item).toLowerCase()));
  }
  return false;
}

function checkLevel(entry: SettingCatalogEntry, scope: SettingScope): void {
  const allowed =
    (scope === 'GLOBAL' && entry.levels !== 'WINERY') ||
    (scope === 'WINERY' && entry.levels !== 'GLOBAL');
  if (!allowed) {
    throw new AppException(
      422,
      ErrorCode.SETTING_LEVEL_NOT_ALLOWED,
      scope === 'WINERY'
        ? `El parámetro ${entry.key} solo tiene estándar general: no admite ajustes por bodega`
        : `El parámetro ${entry.key} solo se configura por bodega`,
      [{ field: 'wineryIds', message: `Nivel permitido: ${entry.levels}` }],
    );
  }
}

function checkNumber(entry: SettingCatalogEntry, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid('Debe ser un número');
  }
  if (entry.integer && !Number.isInteger(value)) {
    throw invalid('Debe ser un número entero');
  }
  if (entry.min !== undefined && value < entry.min) {
    throw invalid(`Debe ser mayor o igual que ${entry.min}`);
  }
  if (entry.max !== undefined && value > entry.max) {
    throw invalid(`Debe ser menor o igual que ${entry.max}`);
  }
  return value;
}

function checkType(entry: SettingCatalogEntry, value: unknown): SettingValue {
  if (value === null) {
    if (entry.type === 'NUMBER_OR_UNLIMITED' || entry.nullable) return null;
    throw invalid('No puede quedar vacío');
  }
  switch (entry.type) {
    case 'NUMBER':
    case 'NUMBER_OR_UNLIMITED':
      return checkNumber(entry, value);
    case 'BOOLEAN':
      if (typeof value !== 'boolean') throw invalid('Debe ser sí o no');
      return value;
    case 'STRING': {
      if (typeof value !== 'string' || value.trim() === '') {
        throw invalid('Debe ser un texto');
      }
      if (value.length > MAX_STRING_LENGTH) {
        throw invalid(`Máximo ${MAX_STRING_LENGTH} caracteres`);
      }
      return value.trim();
    }
    case 'ENUM': {
      const options = entry.enumValues ?? [];
      if (typeof value !== 'string' || !options.includes(value)) {
        throw invalid(`Debe ser uno de: ${options.join(', ')}`);
      }
      return value;
    }
    case 'LIST': {
      if (!Array.isArray(value) || value.length === 0) {
        throw invalid('Debe ser una lista con al menos un elemento');
      }
      if (value.length > MAX_LIST_ITEMS) {
        throw invalid(`Máximo ${MAX_LIST_ITEMS} elementos`);
      }
      const items = value.map((item) => {
        if (typeof item !== 'string' || item.trim() === '') {
          throw invalid('Cada elemento debe ser un texto');
        }
        return item.trim();
      });
      if (new Set(items.map((i) => i.toLowerCase())).size !== items.length) {
        throw invalid('La lista tiene elementos repetidos');
      }
      return items;
    }
    case 'OBJECT': {
      if (!isPlainObject(value)) throw invalid('Debe ser un objeto');
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_JSON_BYTES) {
        throw invalid('El objeto es demasiado grande');
      }
      return value;
    }
    default:
      throw invalid('Tipo de parámetro desconocido');
  }
}

/**
 * Valida un valor contra su definición (tipo, límites, enumeración, nivel y
 * mínimo legal) y lo devuelve normalizado.
 *
 * - Nivel no permitido → 422 `SETTING_LEVEL_NOT_ALLOWED`.
 * - Tipo o límites → 422 `VALIDATION_ERROR` en `value`.
 * - Más laxo que el mínimo legal → 422 `SETTING_BELOW_LEGAL_MINIMUM`, salvo
 *   en un ajuste por bodega con `legalException` (el estándar general nunca
 *   baja del mínimo legal).
 */
export function validateSettingValue(
  entry: SettingCatalogEntry,
  value: unknown,
  options: ValidateOptions,
): ValidatedSetting {
  checkLevel(entry, options.scope);
  if (value === undefined) {
    throw invalid('Falta el valor');
  }
  const normalized = checkType(entry, value);
  const laxer = isLaxerThanLegalMinimum(entry, normalized);
  if (laxer && !(options.scope === 'WINERY' && options.legalException)) {
    throw new AppException(
      422,
      ErrorCode.SETTING_BELOW_LEGAL_MINIMUM,
      options.scope === 'GLOBAL'
        ? `El estándar de ${entry.key} no puede ser más laxo que el mínimo legal`
        : `El valor es más laxo que el mínimo legal de ${entry.key}: requiere una excepción legal autorizada por administración`,
      [
        {
          field: 'value',
          message: `Mínimo legal: ${JSON.stringify(entry.legalMinimum)}`,
        },
      ],
    );
  }
  return { value: normalized, belowLegalMinimum: laxer };
}
