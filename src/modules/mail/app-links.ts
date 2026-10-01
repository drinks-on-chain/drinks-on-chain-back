import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientApp } from '@shared/context/request-context';

/**
 * Enlaces de los correos a la app que corresponde (contrato O1 §2 y §10):
 * bodega → ERP, plataforma → Backoffice, punto de canje → POS; la
 * recuperación de contraseña y la verificación, a la app desde la que se
 * pidió (`X-Client-App`). La URL base de cada app es configuración
 * (`APP_URL_*`); las rutas son las de los mocks (`docs/CONTRATO.md` §6).
 */
export type LinkApp = 'ERP' | 'BACKOFFICE' | 'POS' | 'MARKETPLACE' | 'BODEGAS';

export const DEFAULT_APP_URLS: Readonly<Record<LinkApp, string>> = {
  /** Sitio de las bodegas (`bodegas.`): formulario `/unirse`. */
  BODEGAS: 'http://localhost:3000',
  ERP: 'http://localhost:3002',
  BACKOFFICE: 'http://localhost:3003',
  POS: 'http://localhost:3004',
  MARKETPLACE: 'http://localhost:3005',
};

const ENV_BY_APP: Readonly<Record<LinkApp, string>> = {
  BODEGAS: 'APP_URL_BODEGAS',
  ERP: 'APP_URL_ERP',
  BACKOFFICE: 'APP_URL_BACKOFFICE',
  POS: 'APP_URL_POS',
  MARKETPLACE: 'APP_URL_MARKETPLACE',
};

export const APP_LINK_PATHS = {
  invitation: (token: string) => `/invitacion/${encodeURIComponent(token)}`,
  passwordReset: (token: string) =>
    `/restablecer-contrasena?token=${encodeURIComponent(token)}`,
  emailVerify: (token: string) =>
    `/verificar-correo?token=${encodeURIComponent(token)}`,
  /** Sitio de bodegas: verificación del correo de una solicitud de alta. */
  applicationVerify: (token: string) =>
    `/unirse/verificar?token=${encodeURIComponent(token)}`,
  /** Backoffice: detalle de una solicitud de alta. */
  applicationDetail: (id: string) => `/solicitudes/${encodeURIComponent(id)}`,
  /** Backoffice: ficha de una bodega. */
  wineryDetail: (id: string) => `/bodegas/${encodeURIComponent(id)}`,
} as const;

/** App de los enlaces de una organización según su tipo. */
export function linkAppForOrganization(
  type: 'PLATFORM' | 'WINERY' | 'PICKUP_POINT',
): LinkApp {
  if (type === 'PLATFORM') return 'BACKOFFICE';
  if (type === 'PICKUP_POINT') return 'POS';
  return 'ERP';
}

/** App de los enlaces de cuenta según la app que hizo la petición (ERP por defecto). */
export function linkAppForClient(app: ClientApp | null | undefined): LinkApp {
  if (app === 'BACKOFFICE' || app === 'POS' || app === 'MARKETPLACE') {
    return app;
  }
  return 'ERP';
}

@Injectable()
export class AppLinks {
  private readonly bases: Record<LinkApp, string>;

  constructor(config: ConfigService) {
    const entries = (Object.keys(ENV_BY_APP) as LinkApp[]).map((app) => {
      const raw = config.get<string>(ENV_BY_APP[app])?.trim();
      const base = raw ? raw : DEFAULT_APP_URLS[app];
      return [app, base.replace(/\/+$/, '')] as const;
    });
    this.bases = Object.fromEntries(entries) as Record<LinkApp, string>;
  }

  base(app: LinkApp): string {
    return this.bases[app];
  }

  invitation(app: LinkApp, token: string): string {
    return `${this.bases[app]}${APP_LINK_PATHS.invitation(token)}`;
  }

  passwordReset(app: LinkApp, token: string): string {
    return `${this.bases[app]}${APP_LINK_PATHS.passwordReset(token)}`;
  }

  emailVerify(app: LinkApp, token: string): string {
    return `${this.bases[app]}${APP_LINK_PATHS.emailVerify(token)}`;
  }

  applicationVerify(token: string): string {
    return `${this.bases.BODEGAS}${APP_LINK_PATHS.applicationVerify(token)}`;
  }

  applicationDetail(id: string): string {
    return `${this.bases.BACKOFFICE}${APP_LINK_PATHS.applicationDetail(id)}`;
  }

  /** Inicio del ERP (la bodega entra con su cuenta). */
  erpHome(): string {
    return this.bases.ERP;
  }
}
