import { BRAND } from './layout';
import { linkBlock, P, SMALL } from './account';
import type { MailTemplate } from './index';

/**
 * Correos de la tokenización (contrato O3 §11; `docs-back/07` §6 y §11): al
 * dueño de la bodega, solicitud recibida, cambios pedidos, aprobada (con la
 * emisión en curso) y rechazada, y los cambios de estado de su colección; a
 * operaciones, solicitud nueva o reenviada. Los de NFT emitidos y faltante
 * llegan con sus pasos (3.4 y 3.6).
 */

const NOTE = `style="margin:0;color:${BRAND.muted};"`;

/** La bodega envió (o reenvió) su solicitud: acuse al dueño. */
export const TOKENIZATION_RECEIVED_TEMPLATE: MailTemplate = {
  name: 'tokenizacion-recibida',
  description:
    'Acuse al dueño de la bodega: su solicitud de tokenización está en revisión',
  variables: ['nombre', 'bodega', 'lote', 'cantidad', 'enlace'],
  subject: `Recibimos la solicitud de tokenización de {{lote}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    `Recibimos la solicitud de {{bodega}} para tokenizar {{cantidad}} botellas del lote {{lote}}. El equipo de ${BRAND.name} la revisará y te escribiremos con la respuesta.`,
    'Puedes ver su estado en el ERP:',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Recibimos la solicitud de <strong>{{bodega}}</strong> para tokenizar <strong>{{cantidad}} botellas</strong> del lote <strong>{{lote}}</strong>. El equipo de ${BRAND.name} la revisará y te escribiremos con la respuesta.</p>`,
    linkBlock('Ver la solicitud en el ERP'),
  ].join('\n'),
};

/** Aviso a operaciones: hay una solicitud nueva o reenviada en la bandeja. */
export const TOKENIZATION_NEW_OPERATIONS_TEMPLATE: MailTemplate = {
  name: 'tokenizacion-nueva-operaciones',
  description:
    'Aviso a operaciones de una solicitud de tokenización nueva o reenviada',
  variables: ['nombre', 'bodega', 'lote', 'cantidad', 'tipo', 'enlace'],
  subject: `Solicitud de tokenización {{tipo}}: {{bodega}} · {{lote}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    '{{bodega}} tiene una solicitud de tokenización {{tipo}}: {{cantidad}} botellas del lote {{lote}}.',
    'Revísala en la bandeja del back office:',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}><strong>{{bodega}}</strong> tiene una solicitud de tokenización {{tipo}}: <strong>{{cantidad}} botellas</strong> del lote <strong>{{lote}}</strong>.</p>`,
    linkBlock('Abrir la bandeja'),
  ].join('\n'),
};

/** Operaciones pidió cambios: al dueño, con el mensaje. */
export const TOKENIZATION_CHANGES_TEMPLATE: MailTemplate = {
  name: 'tokenizacion-cambios',
  description:
    'Aviso al dueño de que operaciones pidió cambios en su solicitud, con el mensaje',
  variables: ['nombre', 'lote', 'mensaje', 'enlace'],
  subject: `Cambios pedidos en la tokenización de {{lote}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    `El equipo de ${BRAND.name} revisó la solicitud de tokenización del lote {{lote}} y pide estos cambios:`,
    '{{mensaje}}',
    '',
    'Edita la solicitud y vuelve a enviarla desde el ERP:',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>El equipo de ${BRAND.name} revisó la solicitud de tokenización del lote <strong>{{lote}}</strong> y pide estos cambios:</p>`,
    `<p ${P}><em>{{mensaje}}</em></p>`,
    linkBlock('Editar y reenviar'),
  ].join('\n'),
};

/** Solicitud aprobada: la emisión de los NFT está en curso. */
export const TOKENIZATION_APPROVED_TEMPLATE: MailTemplate = {
  name: 'tokenizacion-aprobada',
  description:
    'Aviso al dueño de que su solicitud fue aprobada y la emisión está en curso',
  variables: ['nombre', 'lote', 'cantidad', 'cuota', 'enlace'],
  subject: `Tokenización aprobada: {{lote}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'La solicitud de tokenización del lote {{lote}} fue aprobada: se emitirán {{cantidad}} NFT a nombre de tu bodega (cuota total del lote: {{cuota}} botellas).',
    'La emisión en la red está en curso; te avisaremos cuando termine. Puedes seguirla en el ERP:',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>La solicitud de tokenización del lote <strong>{{lote}}</strong> fue aprobada: se emitirán <strong>{{cantidad}} NFT</strong> a nombre de tu bodega (cuota total del lote: {{cuota}} botellas).</p>`,
    `<p ${P}>La emisión en la red está en curso; te avisaremos cuando termine.</p>`,
    linkBlock('Seguir la emisión en el ERP'),
  ].join('\n'),
};

/** Solicitud rechazada, con el motivo. */
export const TOKENIZATION_REJECTED_TEMPLATE: MailTemplate = {
  name: 'tokenizacion-rechazada',
  description:
    'Aviso al dueño de que su solicitud de tokenización no fue aprobada, con el motivo',
  variables: ['nombre', 'lote', 'motivo'],
  subject: `La tokenización de {{lote}} no fue aprobada`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'La solicitud de tokenización del lote {{lote}} no fue aprobada.',
    'Motivo: {{motivo}}',
    '',
    'Puedes enviar una solicitud nueva desde el ERP cuando lo consideres.',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>La solicitud de tokenización del lote <strong>{{lote}}</strong> no fue aprobada.</p>`,
    `<p ${P}>Motivo: {{motivo}}</p>`,
    `<p ${SMALL}>Puedes enviar una solicitud nueva desde el ERP cuando lo consideres.</p>`,
  ].join('\n'),
};

/** Colección publicada, pausada, reanudada o cerrada (al dueño). */
export const COLLECTION_STATUS_TEMPLATE: MailTemplate = {
  name: 'coleccion-estado',
  description:
    'Aviso al dueño de que su colección fue publicada, pausada, reanudada o cerrada',
  variables: ['nombre', 'coleccion', 'estado', 'efecto', 'motivo'],
  subject: `{{coleccion}} fue {{estado}} en ${BRAND.name}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'La colección {{coleccion}} fue {{estado}}.',
    '{{efecto}}',
    'Motivo: {{motivo}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>La colección <strong>{{coleccion}}</strong> fue {{estado}}.</p>`,
    `<p ${P}>{{efecto}}</p>`,
    `<p ${NOTE}>Motivo: {{motivo}}</p>`,
  ].join('\n'),
};

export const TOKENIZATION_TEMPLATES: readonly MailTemplate[] = [
  TOKENIZATION_RECEIVED_TEMPLATE,
  TOKENIZATION_NEW_OPERATIONS_TEMPLATE,
  TOKENIZATION_CHANGES_TEMPLATE,
  TOKENIZATION_APPROVED_TEMPLATE,
  TOKENIZATION_REJECTED_TEMPLATE,
  COLLECTION_STATUS_TEMPLATE,
];
