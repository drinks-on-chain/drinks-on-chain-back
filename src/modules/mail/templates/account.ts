import { BRAND } from './layout';
import type { MailTemplate } from './index';

/**
 * Correos de cuenta, segundo factor e invitaciones (contrato O1 §10, CMP-02):
 * invitación, recuperación de contraseña, contraseña cambiada, verificación
 * del correo, segundo factor restablecido, intentos fallidos del segundo
 * factor y aviso al dueño de un cambio hecho por la plataforma en su equipo.
 *
 * Nunca llevan contraseñas; los enlaces son de un solo uso y caducan.
 */

export const P = 'style="margin:0 0 16px 0;"';
export const BUTTON = `style="display:inline-block;padding:12px 20px;background:${BRAND.accentDeep};color:${BRAND.paper};text-decoration:none;border-radius:4px;"`;
export const SMALL = `style="margin:16px 0 0 0;font-size:14px;color:${BRAND.muted};"`;

export function linkBlock(cta: string): string {
  return [
    `<p ${P}><a href="{{enlace}}" ${BUTTON}>${cta}</a></p>`,
    `<p ${SMALL}>Si el botón no funciona, copia este enlace en tu navegador:<br><a href="{{enlace}}" style="color:${BRAND.accentDeep};word-break:break-all;">{{enlace}}</a></p>`,
  ].join('\n');
}

/** Invitación a una organización (dueño, colaborador, usuario interno). */
export const INVITATION_TEMPLATE: MailTemplate = {
  name: 'invitacion',
  description:
    'Invitación a una organización (bodega → ERP, plataforma → Backoffice, punto → POS)',
  variables: ['invitante', 'organizacion', 'rol', 'enlace', 'caduca'],
  subject: `Invitación a {{organizacion}} en ${BRAND.name}`,
  text: [
    'Hola:',
    '',
    '{{invitante}} te invita a {{organizacion}} con el rol de {{rol}}.',
    '',
    'Acepta la invitación en este enlace (de un solo uso, caduca el {{caduca}}):',
    '{{enlace}}',
    '',
    'Si ya tienes una cuenta con este correo, inicia sesión y acepta; si no, podrás crearla con tu nombre y una contraseña.',
  ].join('\n'),
  html: [
    `<p ${P}>Hola:</p>`,
    `<p ${P}>{{invitante}} te invita a <strong>{{organizacion}}</strong> con el rol de <strong>{{rol}}</strong>.</p>`,
    linkBlock('Aceptar la invitación'),
    `<p ${SMALL}>El enlace es de un solo uso y caduca el {{caduca}}. Si ya tienes una cuenta con este correo, inicia sesión y acepta; si no, podrás crearla con tu nombre y una contraseña.</p>`,
  ].join('\n'),
};

/** Recuperación de contraseña (IAM-05). */
export const PASSWORD_RESET_TEMPLATE: MailTemplate = {
  name: 'recuperar-contrasena',
  description: 'Enlace de un solo uso para elegir una contraseña nueva',
  variables: ['nombre', 'enlace', 'minutos'],
  subject: `Restablece tu contraseña de ${BRAND.name}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'Pediste restablecer tu contraseña. Elige una nueva en este enlace (de un solo uso, caduca en {{minutos}} minutos):',
    '{{enlace}}',
    '',
    'Si no fuiste tú, ignora este correo: tu contraseña no cambia.',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Pediste restablecer tu contraseña. Elige una nueva con este enlace, de un solo uso, que caduca en {{minutos}} minutos.</p>`,
    linkBlock('Elegir una contraseña nueva'),
    `<p ${SMALL}>Si no fuiste tú, ignora este correo: tu contraseña no cambia.</p>`,
  ].join('\n'),
};

/** Aviso de contraseña cambiada (restablecida o cambiada desde el perfil). */
export const PASSWORD_CHANGED_TEMPLATE: MailTemplate = {
  name: 'contrasena-cambiada',
  description: 'Aviso de que la contraseña de la cuenta cambió',
  variables: ['nombre'],
  subject: `Tu contraseña de ${BRAND.name} cambió`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'La contraseña de tu cuenta se acaba de cambiar y se cerraron tus otras sesiones.',
    `Si no fuiste tú, restablécela de inmediato y avisa al equipo de ${BRAND.name}.`,
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>La contraseña de tu cuenta se acaba de cambiar y se cerraron tus otras sesiones.</p>`,
    `<p style="margin:0;color:${BRAND.accentDeep};">Si no fuiste tú, restablécela de inmediato y avisa al equipo de ${BRAND.name}.</p>`,
  ].join('\n'),
};

/** Verificación del correo (IAM-06). */
export const EMAIL_VERIFY_TEMPLATE: MailTemplate = {
  name: 'verificar-correo',
  description: 'Enlace para confirmar que el correo es de la persona',
  variables: ['nombre', 'enlace', 'horas'],
  subject: `Confirma tu correo en ${BRAND.name}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'Confirma que este correo es tuyo con este enlace (caduca en {{horas}} horas):',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Confirma que este correo es tuyo. El enlace caduca en {{horas}} horas.</p>`,
    linkBlock('Confirmar el correo'),
  ].join('\n'),
};

/** Segundo factor restablecido por administración (PLT-05). */
export const MFA_RESET_TEMPLATE: MailTemplate = {
  name: 'segundo-factor-restablecido',
  description: 'Aviso de que administración restableció el segundo factor',
  variables: ['nombre'],
  subject: `Tu segundo factor de ${BRAND.name} se restableció`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'El equipo de administración restableció tu segundo factor y cerró tus sesiones.',
    'La próxima vez que inicies sesión tendrás que inscribir de nuevo tu app de autenticación.',
    `Si no lo pediste, avisa al equipo de ${BRAND.name}.`,
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>El equipo de administración restableció tu segundo factor y cerró tus sesiones. La próxima vez que inicies sesión tendrás que inscribir de nuevo tu app de autenticación.</p>`,
    `<p style="margin:0;color:${BRAND.accentDeep};">Si no lo pediste, avisa al equipo de ${BRAND.name}.</p>`,
  ].join('\n'),
};

/** Varios códigos del segundo factor incorrectos seguidos. */
export const MFA_FAILED_ATTEMPTS_TEMPLATE: MailTemplate = {
  name: 'segundo-factor-intentos-fallidos',
  description: 'Aviso de códigos de segundo factor incorrectos seguidos',
  variables: ['nombre', 'intentos', 'minutos'],
  subject: `Intentos fallidos de segundo factor en ${BRAND.name}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'Hubo {{intentos}} códigos de verificación incorrectos seguidos al iniciar sesión con tu cuenta. El segundo factor queda bloqueado {{minutos}} minutos.',
    `Si no fuiste tú, alguien conoce tu contraseña: cámbiala y avisa al equipo de ${BRAND.name}.`,
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Hubo {{intentos}} códigos de verificación incorrectos seguidos al iniciar sesión con tu cuenta. El segundo factor queda bloqueado {{minutos}} minutos.</p>`,
    `<p style="margin:0;color:${BRAND.accentDeep};">Si no fuiste tú, alguien conoce tu contraseña: cámbiala y avisa al equipo de ${BRAND.name}.</p>`,
  ].join('\n'),
};

/**
 * Aviso al dueño de una organización de un cambio que hizo la plataforma en
 * su equipo (EQP-10): invitación, bloqueo, desbloqueo o cambio de rol.
 * `motivo` puede ir vacío.
 */
export const TEAM_NOTICE_TEMPLATE: MailTemplate = {
  name: 'aviso-equipo',
  description:
    'Aviso al dueño de un cambio de la plataforma en el equipo de su organización',
  variables: ['nombre', 'organizacion', 'cambio', 'motivo'],
  subject: `Cambio en el equipo de {{organizacion}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    `El equipo de ${BRAND.name} hizo un cambio en el equipo de {{organizacion}}:`,
    '{{cambio}}',
    '{{#if motivo}}',
    'Motivo: {{motivo}}',
    '{{/if}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>El equipo de ${BRAND.name} hizo un cambio en el equipo de <strong>{{organizacion}}</strong>:</p>`,
    `<p ${P}>{{cambio}}</p>`,
    `{{#if motivo}}<p style="margin:0;color:${BRAND.muted};">Motivo: {{motivo}}</p>{{/if}}`,
  ].join('\n'),
};

export const ACCOUNT_TEMPLATES: readonly MailTemplate[] = [
  INVITATION_TEMPLATE,
  PASSWORD_RESET_TEMPLATE,
  PASSWORD_CHANGED_TEMPLATE,
  EMAIL_VERIFY_TEMPLATE,
  MFA_RESET_TEMPLATE,
  MFA_FAILED_ATTEMPTS_TEMPLATE,
  TEAM_NOTICE_TEMPLATE,
];

/** Etiqueta en español de un rol para los correos. */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  SUPERADMIN: 'superusuario',
  ADMIN: 'administración',
  OPERATIONS: 'operaciones',
  SUPPORT: 'soporte',
  OWNER: 'dueño o dueña',
  ENOLOGIST: 'enología',
  AGRONOMIST: 'agronomía',
  OPERATOR: 'operario de planta',
  ACCOUNTANT: 'contabilidad',
  MANAGER: 'encargado del punto',
  CASHIER: 'cajero',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** Fecha y hora de Bolivia para los correos: "30 de septiembre de 2026, 10:00 (hora de Bolivia)". */
export function formatMailDate(date: Date): string {
  const formatted = new Intl.DateTimeFormat('es-BO', {
    timeZone: 'America/La_Paz',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${formatted} (hora de Bolivia)`;
}
