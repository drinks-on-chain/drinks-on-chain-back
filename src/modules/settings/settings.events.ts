/**
 * Eventos del outbox del módulo de configuración. Carga mínima: la clave y
 * el ámbito, sin valores.
 */
export const SETTING_AGGREGATE = 'setting';

/** Cambió un estándar general o los ajustes de unas bodegas. */
export const SETTING_CHANGED = 'setting.changed';

export type SettingChangedPayload = {
  key: string;
  scope: 'GLOBAL' | 'WINERY';
  wineryIds: string[];
};
