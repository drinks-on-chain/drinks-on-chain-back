/**
 * Tipos de la configuración en dos niveles (contrato O1 §6, docs-back/05 §4).
 */

export const SETTING_TYPES = [
  'NUMBER',
  'BOOLEAN',
  'STRING',
  'LIST',
  'OBJECT',
  'NUMBER_OR_UNLIMITED',
  'ENUM',
] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

/** GLOBAL = solo estándar · GLOBAL_AND_WINERY = estándar y ajuste · WINERY = solo por bodega. */
export type SettingLevels = 'GLOBAL' | 'GLOBAL_AND_WINERY' | 'WINERY';

/** Cuándo se aplica un cambio: se fija en el lote, en la colección o de inmediato. */
export type SettingAppliesAt = 'LOT' | 'COLLECTION' | 'IMMEDIATE';

/** Valor JSON de un parámetro. `null` = vacío (ilimitado, desactivado, sin definir). */
export type SettingValue =
  number | boolean | string | string[] | { [key: string]: unknown } | null;

export interface SettingCatalogEntry {
  key: string;
  description: string;
  type: SettingType;
  enumValues?: readonly string[];
  unit?: string;
  levels: SettingLevels;
  appliesAt: SettingAppliesAt;
  default: SettingValue;
  min?: number;
  max?: number;
  /** Solo enteros (días, horas, cantidades). */
  integer?: boolean;
  /** Admite `null` (además de `NUMBER_OR_UNLIMITED`, que siempre lo admite). */
  nullable?: boolean;
  /**
   * Piso legal (A-31): número (un valor menor es más laxo) o lista (un
   * elemento fuera de ella es más laxo). Un ajuste por bodega más laxo exige
   * `legalException` (solo administración, con motivo).
   */
  legalMinimum?: number | readonly string[] | null;
}

/** De dónde sale el valor efectivo. */
export type SettingSource = 'DEFAULT' | 'GLOBAL' | 'WINERY';

export interface ResolvedSetting {
  key: string;
  value: SettingValue;
  source: SettingSource;
  /** El valor es un ajuste por bodega autorizado bajo el mínimo legal. */
  legalException: boolean;
}

/** Valor efectivo visible para una bodega (`GET /organizations/current/settings`). */
export interface EffectiveSettingView {
  key: string;
  description: string;
  value: SettingValue;
  /** `GLOBAL` también cuando se usa el valor por defecto (es el estándar). */
  source: 'GLOBAL' | 'WINERY';
  appliesAt: SettingAppliesAt;
}

/**
 * Instantánea de las reglas que se fijan en el lote al crearlo (CFG-06, Ola
 * 2): el lote valida contra esto aunque la configuración cambie después.
 */
export interface SettingsSnapshot {
  wineryId: string;
  takenAt: string;
  values: Record<string, SettingValue>;
  sources: Record<string, SettingSource>;
  /** Claves con un ajuste bajo el mínimo legal (el pasaporte lo indica). */
  legalExceptions: string[];
}

/** Definición con su estándar general para el back office (contrato O1 §6). */
export interface SettingDefinitionView {
  key: string;
  description: string;
  type: SettingType;
  enumValues?: string[];
  unit?: string;
  levels: SettingLevels;
  appliesAt: SettingAppliesAt;
  default: SettingValue;
  min?: number;
  max?: number;
  legalMinimum: number | string[] | null;
  /** Estándar general vigente (el valor por defecto si nunca se cambió). */
  globalValue: SettingValue;
  /** Bodegas con un ajuste propio. */
  overridesCount: number;
  updatedAt: string;
  /** Nombre de quien cambió el estándar por última vez; `null` = instalación. */
  updatedBy: string | null;
}

/** Ajuste de una bodega (`GET /v1/platform/settings/{key}/overrides`). */
export interface SettingOverrideView {
  wineryId: string;
  wineryName: string;
  value: SettingValue;
  legalException: boolean;
  reason: string;
  updatedAt: string;
  /** Nombre de quien lo aplicó (`Sistema` si no hay persona). */
  updatedBy: string;
}

/** Entrada del historial (`GET /v1/platform/settings/{key}/history`). */
export interface SettingHistoryView {
  at: string;
  /** Nombre de quien lo cambió (`Sistema` si no hay persona). */
  by: string;
  /** `GLOBAL` o el id de la bodega. */
  scope: string;
  /** Valor antes y después; sin ajuste propio = el estándar vigente en ese momento. */
  before: SettingValue;
  after: SettingValue;
  reason: string;
  /** Ajuste autorizado bajo el mínimo legal (A-31). Adicional al contrato. */
  legalException: boolean;
}
