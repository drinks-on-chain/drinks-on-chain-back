/**
 * Marco común de los correos (Handlebars): marca Drinks on Chain, papel
 * `#fdfcf5`, tinta y un solo oro, tipografía serif con alternativas seguras
 * para clientes de correo, estilos en línea y ancho máximo de 600 px.
 *
 * Recibe `{{{body}}}` (HTML ya renderizado y escapado de la plantilla) y
 * `{{subject}}`. El resto de variables las escapa Handlebars.
 */
export const BRAND = {
  name: 'Drinks on Chain',
  paper: '#fdfcf5',
  ink: '#1f1b16',
  muted: '#5c554b',
  // Oro para texto pequeño y fondos con texto (contraste AA sobre papel)
  accentDeep: '#7a5a12',
  rule: '#e6dcc3',
} as const;

export const HTML_LAYOUT = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{{subject}}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paper};color:${BRAND.ink};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
<tr><td style="padding:0 0 16px 0;border-bottom:1px solid ${BRAND.rule};font-family:'Cormorant Garamond','EB Garamond',Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:0.02em;color:${BRAND.ink};">
${BRAND.name}
</td></tr>
<tr><td style="padding:24px 0;font-family:'EB Garamond',Georgia,'Times New Roman',serif;font-size:17px;line-height:1.6;color:${BRAND.ink};">
{{{body}}}
</td></tr>
<tr><td style="padding:16px 0 0 0;border-top:1px solid ${BRAND.rule};font-family:'EB Garamond',Georgia,'Times New Roman',serif;font-size:13px;line-height:1.5;color:${BRAND.muted};">
Este es un mensaje automático de ${BRAND.name}. Si no esperabas este correo, puedes ignorarlo.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

/** Pie común del texto plano. */
export const TEXT_FOOTER = `\n\n--\n${BRAND.name}\nEste es un mensaje automático. Si no esperabas este correo, puedes ignorarlo.\n`;
