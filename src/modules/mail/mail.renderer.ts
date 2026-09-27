import * as Handlebars from 'handlebars';
import { HTML_LAYOUT, TEXT_FOOTER } from './templates/layout';
import { MailTemplate, mailTemplate } from './templates';

/** Valores admitidos en las variables de una plantilla. */
export type MailVariables = Record<string, string | number | boolean | null>;

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Motor sencillo y seguro: Handlebars en modo estricto (una variable que
 * falta es un error, no un hueco), sin helpers ni parciales propios, HTML
 * escapado por defecto y variables planas (sin objetos: nada de
 * `{{a.constructor}}`). El texto y el asunto no se escapan (no son HTML) y el
 * asunto no admite saltos de línea (inyección de cabeceras).
 */
export class MailRenderer {
  private readonly hbs = Handlebars.create();
  private readonly cache = new Map<
    string,
    {
      subject: Handlebars.TemplateDelegate;
      text: Handlebars.TemplateDelegate;
      html: Handlebars.TemplateDelegate;
    }
  >();
  private readonly layout = this.hbs.compile(HTML_LAYOUT, { strict: true });

  render(templateName: string, variables: MailVariables): RenderedMail {
    const template = mailTemplate(templateName);
    if (!template) {
      throw new Error(`Plantilla de correo desconocida: ${templateName}`);
    }
    MailRenderer.checkVariables(template, variables);
    const compiled = this.compiled(template);
    const data = { ...variables };
    const subject = compiled
      .subject(data)
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 300);
    const body = compiled.html(data);
    return {
      subject,
      text: `${compiled.text(data).trim()}${TEXT_FOOTER}`,
      html: this.layout({ subject, body }),
    };
  }

  /** Comprueba que llegan las variables exigidas y que todas son planas. */
  static checkVariables(template: MailTemplate, variables: unknown): void {
    if (
      typeof variables !== 'object' ||
      variables === null ||
      Array.isArray(variables)
    ) {
      throw new Error('Las variables del correo deben ser un objeto');
    }
    const vars = variables as Record<string, unknown>;
    for (const [key, value] of Object.entries(vars)) {
      if (
        value !== null &&
        !['string', 'number', 'boolean'].includes(typeof value)
      ) {
        throw new Error(`La variable ${key} debe ser un valor simple`);
      }
    }
    const missing = template.variables.filter(
      (name) => vars[name] === undefined || vars[name] === null,
    );
    if (missing.length > 0) {
      throw new Error(
        `Faltan variables para la plantilla ${template.name}: ${missing.join(', ')}`,
      );
    }
  }

  private compiled(template: MailTemplate) {
    let entry = this.cache.get(template.name);
    if (!entry) {
      entry = {
        subject: this.hbs.compile(template.subject, {
          strict: true,
          noEscape: true,
        }),
        text: this.hbs.compile(template.text, { strict: true, noEscape: true }),
        html: this.hbs.compile(template.html, { strict: true }),
      };
      this.cache.set(template.name, entry);
    }
    return entry;
  }
}
