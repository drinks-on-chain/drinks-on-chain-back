import { BRAND } from './layout';
import { linkBlock, P, SMALL } from './account';
import type { MailTemplate } from './index';

/**
 * Correos de las solicitudes de alta y de las bodegas (contrato O1 §10,
 * CMP-02; docs-back/07 §11): verificación del correo de la solicitud,
 * solicitud recibida, aprobada y rechazada (al contacto), avisos a
 * operaciones y cambios de estado de la bodega (al dueño). Los cambios del
 * equipo hechos por la plataforma usan `aviso-equipo` (account.ts).
 */

const NOTE = `style="margin:0;color:${BRAND.muted};"`;

/** Verificación del correo de contacto de una solicitud (sitio de bodegas). */
export const APPLICATION_VERIFY_TEMPLATE: MailTemplate = {
  name: 'solicitud-verificar',
  description:
    'Confirmación del correo de contacto de una solicitud de alta (enlace al sitio de bodegas)',
  variables: ['nombre', 'bodega', 'enlace', 'horas'],
  subject: `Confirma la solicitud de {{bodega}} en ${BRAND.name}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    `Recibimos la solicitud de alta de {{bodega}} en ${BRAND.name}. Para que el equipo la revise, confirma que este correo es tuyo (el enlace caduca en {{horas}} horas):`,
    '{{enlace}}',
    '',
    'Si no enviaste ninguna solicitud, ignora este correo.',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Recibimos la solicitud de alta de <strong>{{bodega}}</strong> en ${BRAND.name}. Para que el equipo la revise, confirma que este correo es tuyo. El enlace caduca en {{horas}} horas.</p>`,
    linkBlock('Confirmar la solicitud'),
    `<p ${SMALL}>Si no enviaste ninguna solicitud, ignora este correo.</p>`,
  ].join('\n'),
};

/** Solicitud verificada: ya la revisa operaciones. */
export const APPLICATION_RECEIVED_TEMPLATE: MailTemplate = {
  name: 'solicitud-recibida',
  description: 'Aviso al contacto de que la solicitud está en revisión',
  variables: ['nombre', 'bodega'],
  subject: `Recibimos la solicitud de {{bodega}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    `Gracias. La solicitud de {{bodega}} ya está en manos del equipo de operaciones de ${BRAND.name}.`,
    'Te escribiremos a este correo con la respuesta o para agendar una reunión.',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Gracias. La solicitud de <strong>{{bodega}}</strong> ya está en manos del equipo de operaciones de ${BRAND.name}.</p>`,
    `<p ${NOTE}>Te escribiremos a este correo con la respuesta o para agendar una reunión.</p>`,
  ].join('\n'),
};

/** Solicitud aprobada (la persona titular recibe aparte su invitación). */
export const APPLICATION_APPROVED_TEMPLATE: MailTemplate = {
  name: 'solicitud-aprobada',
  description: 'Aviso al contacto de que la solicitud fue aprobada',
  variables: ['nombre', 'bodega', 'titular'],
  subject: `{{bodega}} fue aprobada en ${BRAND.name}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    `La solicitud de {{bodega}} fue aprobada. {{titular}} recibirá una invitación por correo para activar la cuenta de la bodega y entrar al ERP.`,
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>La solicitud de <strong>{{bodega}}</strong> fue aprobada.</p>`,
    `<p ${NOTE}>{{titular}} recibirá una invitación por correo para activar la cuenta de la bodega y entrar al ERP.</p>`,
  ].join('\n'),
};

/** Solicitud rechazada con motivo. */
export const APPLICATION_REJECTED_TEMPLATE: MailTemplate = {
  name: 'solicitud-rechazada',
  description:
    'Aviso al contacto de que la solicitud no fue aprobada, con el motivo',
  variables: ['nombre', 'bodega', 'motivo'],
  subject: `Sobre la solicitud de {{bodega}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'Revisamos la solicitud de {{bodega}} y por ahora no podemos aprobarla.',
    'Motivo: {{motivo}}',
    '',
    'Si cambia algo, puedes volver a enviarla desde el sitio de bodegas.',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Revisamos la solicitud de <strong>{{bodega}}</strong> y por ahora no podemos aprobarla.</p>`,
    `<p ${P}>Motivo: {{motivo}}</p>`,
    `<p ${NOTE}>Si cambia algo, puedes volver a enviarla desde el sitio de bodegas.</p>`,
  ].join('\n'),
};

/** Aviso a operaciones: solicitud nueva verificada. */
export const APPLICATION_NEW_OPERATIONS_TEMPLATE: MailTemplate = {
  name: 'solicitud-nueva-operaciones',
  description:
    'Aviso a operaciones de una solicitud de alta nueva (verificada)',
  variables: ['nombre', 'bodega', 'region', 'contacto', 'enlace'],
  subject: `Solicitud nueva: {{bodega}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    '{{bodega}} ({{region}}) envió una solicitud de alta y confirmó su correo.',
    'Contacto: {{contacto}}.',
    '',
    'Revísala en el back office:',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}><strong>{{bodega}}</strong> ({{region}}) envió una solicitud de alta y confirmó su correo. Contacto: {{contacto}}.</p>`,
    linkBlock('Ver la solicitud'),
  ].join('\n'),
};

/** Aviso a operaciones: formulario con un NIT ya registrado (se respondió 202). */
export const APPLICATION_DUPLICATE_OPERATIONS_TEMPLATE: MailTemplate = {
  name: 'solicitud-duplicada-operaciones',
  description:
    'Aviso a operaciones de una solicitud con un NIT que ya tiene bodega o solicitud abierta',
  variables: ['nombre', 'bodega', 'nit', 'contacto'],
  subject: `Solicitud duplicada: NIT {{nit}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'Llegó una solicitud de {{bodega}} con el NIT {{nit}}, que ya tiene una bodega o una solicitud abierta. No se creó nada.',
    'Contacto: {{contacto}}.',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Llegó una solicitud de <strong>{{bodega}}</strong> con el NIT {{nit}}, que ya tiene una bodega o una solicitud abierta. No se creó nada.</p>`,
    `<p ${NOTE}>Contacto: {{contacto}}.</p>`,
  ].join('\n'),
};

/** Bodega suspendida, reactivada o revocada por la plataforma (al dueño). */
export const WINERY_STATUS_TEMPLATE: MailTemplate = {
  name: 'bodega-estado',
  description:
    'Aviso al dueño de que la plataforma suspendió, reactivó o revocó la bodega',
  variables: ['nombre', 'bodega', 'estado', 'efecto', 'motivo'],
  subject: `{{bodega}} fue {{estado}} en ${BRAND.name}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    `El equipo de ${BRAND.name} dejó {{bodega}} {{estado}}.`,
    '{{efecto}}',
    'Motivo: {{motivo}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>El equipo de ${BRAND.name} dejó <strong>{{bodega}}</strong> {{estado}}.</p>`,
    `<p ${P}>{{efecto}}</p>`,
    `<p ${NOTE}>Motivo: {{motivo}}</p>`,
  ].join('\n'),
};

export const ORGANIZATION_TEMPLATES: readonly MailTemplate[] = [
  APPLICATION_VERIFY_TEMPLATE,
  APPLICATION_RECEIVED_TEMPLATE,
  APPLICATION_APPROVED_TEMPLATE,
  APPLICATION_REJECTED_TEMPLATE,
  APPLICATION_NEW_OPERATIONS_TEMPLATE,
  APPLICATION_DUPLICATE_OPERATIONS_TEMPLATE,
  WINERY_STATUS_TEMPLATE,
];
