import { BRAND } from './layout';
import { ACCOUNT_TEMPLATES } from './account';

/**
 * Plantilla de correo: asunto, texto plano y cuerpo HTML en Handlebars, con
 * las variables que exige. Español (docs-back/07 §11); el marco común está en
 * `layout.ts`. Las plantillas se escriben en el código (no las edita nadie en
 * tiempo de ejecución), así que no hay plantillas de terceros que escapar.
 */
export interface MailTemplate {
  name: string;
  description: string;
  /** Variables obligatorias (Handlebars en modo estricto también lo exige). */
  variables: readonly string[];
  subject: string;
  text: string;
  /** Cuerpo HTML; `{{var}}` se escapa, `{{{var}}}` no se usa con datos externos. */
  html: string;
}

/** Correo de prueba de la cola y del SMTP (CMP-01). */
const TEST_TEMPLATE: MailTemplate = {
  name: 'prueba',
  description: 'Correo de prueba del servicio de correo',
  variables: ['nombre', 'entorno'],
  subject: `Correo de prueba de ${BRAND.name} ({{entorno}})`,
  text: [
    'Hola, {{nombre}}:',
    '',
    `Este es un correo de prueba del servicio de correo de ${BRAND.name} en el entorno {{entorno}}.`,
    'Si lo estás leyendo, la cola y el envío funcionan.',
  ].join('\n'),
  html: [
    `<p style="margin:0 0 16px 0;">Hola, {{nombre}}:</p>`,
    `<p style="margin:0 0 16px 0;">Este es un correo de prueba del servicio de correo de ${BRAND.name} en el entorno <strong>{{entorno}}</strong>.</p>`,
    `<p style="margin:0;color:${BRAND.accentDeep};">Si lo estás leyendo, la cola y el envío funcionan.</p>`,
  ].join('\n'),
};

export const MAIL_TEMPLATES: readonly MailTemplate[] = [
  TEST_TEMPLATE,
  ...ACCOUNT_TEMPLATES,
];

const BY_NAME = new Map(MAIL_TEMPLATES.map((t) => [t.name, t]));

export function mailTemplate(name: string): MailTemplate | undefined {
  return BY_NAME.get(name);
}
