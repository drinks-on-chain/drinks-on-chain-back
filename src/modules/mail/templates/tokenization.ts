import { BRAND } from './layout';
import { linkBlock, P, SMALL } from './account';
import type { MailTemplate } from './index';

/**
 * Correos de la tokenización (contrato O3 §11; `docs-back/07` §6 y §11): al
 * dueño de la bodega, solicitud recibida, cambios pedidos, aprobada (con la
 * emisión en curso) y rechazada, y los cambios de estado de su colección; a
 * operaciones, solicitud nueva o reenviada. Con la emisión confirmada, NFT emitidos
 * (con enlace al contrato). Con el lote embotellado, el faltante (al dueño y a
 * operaciones). Y las alertas `CRITICAL` de la cadena, a operaciones.
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

/** La emisión se confirmó en la red: al dueño, con el contrato (§11). */
export const NFT_MINTED_TEMPLATE: MailTemplate = {
  name: 'nft-emitidos',
  description:
    'Aviso al dueño de que los NFT de su lote ya están emitidos en la red, con enlace al contrato',
  variables: [
    'nombre',
    'coleccion',
    'lote',
    'cantidad',
    'botellas',
    'contrato',
    'explorador',
    'estado',
    'enlace',
  ],
  subject: `{{cantidad}} NFT emitidos: {{coleccion}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'Ya están emitidos en la red Stellar {{cantidad}} NFT del lote {{lote}} (botellas {{botellas}}), a nombre de tu bodega.',
    '{{estado}}',
    'Contrato: {{contrato}}',
    '{{explorador}}',
    '',
    'Puedes verlos en el ERP:',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Ya están emitidos en la red Stellar <strong>{{cantidad}} NFT</strong> del lote <strong>{{lote}}</strong> (botellas {{botellas}}), a nombre de tu bodega.</p>`,
    `<p ${P}>{{estado}}</p>`,
    `<p ${NOTE}>Contrato: <a href="{{explorador}}" style="color:${BRAND.accentDeep};word-break:break-all;">{{contrato}}</a></p>`,
    linkBlock('Ver la colección en el ERP'),
  ].join('\n'),
};

/** El lote tiene menos botellas que NFT emitidos: al dueño (§8.4). */
export const SHORTFALL_DETECTED_TEMPLATE: MailTemplate = {
  name: 'faltante-detectado',
  description:
    'Aviso al dueño de la bodega: su lote tiene menos botellas que NFT emitidos',
  variables: [
    'nombre',
    'lote',
    'botellas',
    'emitidos',
    'faltante',
    'sinVender',
    'vendidos',
    'enlace',
  ],
  subject: `Faltante de botellas en {{lote}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'El lote {{lote}} tiene {{botellas}} botellas y {{emitidos}} NFT emitidos: faltan {{faltante}} botellas.',
    `De los NFT afectados, {{sinVender}} no se han vendido (el equipo de ${BRAND.name} los retirará de la red) y {{vendidos}} ya tienen comprador (te contactaremos para resolverlos uno a uno).`,
    'No necesitas hacer nada en la red. Puedes ver el cierre del lote en el ERP:',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>El lote <strong>{{lote}}</strong> tiene <strong>{{botellas}} botellas</strong> y <strong>{{emitidos}} NFT</strong> emitidos: faltan <strong>{{faltante}} botellas</strong>.</p>`,
    `<p ${P}>De los NFT afectados, {{sinVender}} no se han vendido (el equipo de ${BRAND.name} los retirará de la red) y {{vendidos}} ya tienen comprador (te contactaremos para resolverlos uno a uno).</p>`,
    `<p ${NOTE}>No necesitas hacer nada en la red.</p>`,
    linkBlock('Ver el cierre del lote en el ERP'),
  ].join('\n'),
};

/** Faltante detectado: a operaciones, que decide el cierre (§8.4). */
export const SHORTFALL_OPERATIONS_TEMPLATE: MailTemplate = {
  name: 'faltante-operaciones',
  description:
    'Aviso a operaciones de un lote con menos botellas que NFT: hay que decidir el cierre',
  variables: [
    'nombre',
    'bodega',
    'lote',
    'botellas',
    'emitidos',
    'faltante',
    'sinVender',
    'vendidos',
    'enlace',
  ],
  subject: `Faltante de {{faltante}} botellas: {{bodega}} · {{lote}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'El lote {{lote}} de {{bodega}} tiene {{botellas}} botellas y {{emitidos}} NFT emitidos: faltan {{faltante}}.',
    'NFT sin vender que hay que quemar: {{sinVender}}. NFT vendidos sin botella (devolución o sustitución, uno a uno): {{vendidos}}.',
    'La decisión del cierre con quemas es de administración:',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>El lote <strong>{{lote}}</strong> de <strong>{{bodega}}</strong> tiene {{botellas}} botellas y {{emitidos}} NFT emitidos: faltan <strong>{{faltante}}</strong>.</p>`,
    `<p ${P}>NFT sin vender que hay que quemar: <strong>{{sinVender}}</strong>. NFT vendidos sin botella (devolución o sustitución, uno a uno): <strong>{{vendidos}}</strong>.</p>`,
    `<p ${NOTE}>La decisión del cierre con quemas es de administración.</p>`,
    linkBlock('Abrir el back office'),
  ].join('\n'),
};

/** Alerta `CRITICAL` de la cadena: a operaciones (§8.2 y §11). */
export const CHAIN_ALERT_TEMPLATE: MailTemplate = {
  name: 'alerta-cadena',
  description:
    'Aviso a operaciones de una alerta crítica de la cadena (conciliación, indexador o firmante)',
  variables: ['nombre', 'codigo', 'red', 'mensaje', 'detectada', 'enlace'],
  subject: `Alerta crítica de la cadena ({{red}}): {{codigo}}`,
  text: [
    'Hola, {{nombre}}:',
    '',
    'Se abrió una alerta crítica de la cadena en la red {{red}}: {{codigo}}.',
    '{{mensaje}}',
    'Detectada: {{detectada}}.',
    '',
    'Nada se corrige solo: revísala y resuélvela en el back office.',
    '{{enlace}}',
  ].join('\n'),
  html: [
    `<p ${P}>Hola, {{nombre}}:</p>`,
    `<p ${P}>Se abrió una alerta crítica de la cadena en la red <strong>{{red}}</strong>: <strong>{{codigo}}</strong>.</p>`,
    `<p ${P}><em>{{mensaje}}</em></p>`,
    `<p ${NOTE}>Detectada: {{detectada}}. Nada se corrige solo: revísala y resuélvela en el back office.</p>`,
    linkBlock('Abrir el back office'),
  ].join('\n'),
};

export const TOKENIZATION_TEMPLATES: readonly MailTemplate[] = [
  TOKENIZATION_RECEIVED_TEMPLATE,
  TOKENIZATION_NEW_OPERATIONS_TEMPLATE,
  TOKENIZATION_CHANGES_TEMPLATE,
  TOKENIZATION_APPROVED_TEMPLATE,
  TOKENIZATION_REJECTED_TEMPLATE,
  COLLECTION_STATUS_TEMPLATE,
  NFT_MINTED_TEMPLATE,
  SHORTFALL_DETECTED_TEMPLATE,
  SHORTFALL_OPERATIONS_TEMPLATE,
  CHAIN_ALERT_TEMPLATE,
];
