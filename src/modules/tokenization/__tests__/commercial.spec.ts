import { Reflector } from '@nestjs/core';
import { MailRenderer } from '@modules/mail/mail.renderer';
import { mailTemplate } from '@modules/mail/templates';
import { TOKENIZATION_TEMPLATES } from '@modules/mail/templates/tokenization';
import { JOB_HANDLER_METADATA } from '@shared/queue/job-handler';
import {
  collectionImagesArePublic,
  publicCollectionImageUrl,
} from '../collection-images';
import {
  changedCommercialFields,
  collectionSlug,
  commercialMissing,
  duplicatedImageKeys,
  EMPTY_COMMERCIAL_DRAFT,
  formatPrice,
  mergeCommercial,
  parseCommercialDraft,
  priceViolations,
} from '../domain/commercial';
import {
  TOKENIZATION_EVENT_HANDLERS,
  TokenizationRequestApprovedHandler,
} from '../jobs/tokenization-events.handlers';
import { mintIntentKey } from '../ports/tokenization-chain.port';
import { stroopsToXlm } from '../tokenization-data';

describe('Datos comerciales de la colección (contrato O3 §5.5)', () => {
  const image = (key: string, isCover = false) => ({
    key,
    alt: `Foto ${key}`,
    isCover,
  });

  it('una entrada parcial solo toca lo que trae', () => {
    const draft = mergeCommercial(EMPTY_COMMERCIAL_DRAFT, {
      name: '  Singani Preventa 2026 ',
      description: 'Singani de altura del Valle de Cinti.',
      imageKeys: [image('a', true)],
    });
    expect(draft).toMatchObject({
      name: 'Singani Preventa 2026',
      tastingNotes: null,
      imageKeys: [{ key: 'a', isCover: true }],
    });
    const next = mergeCommercial(draft, { tastingNotes: 'Flores blancas' });
    expect(next).toEqual({ ...draft, tastingNotes: 'Flores blancas' });
    expect(changedCommercialFields(draft, next)).toEqual(['tastingNotes']);
  });

  it('null o vacío borra un campo opcional', () => {
    const draft = mergeCommercial(EMPTY_COMMERCIAL_DRAFT, {
      pairing: 'Quesos',
    });
    expect(mergeCommercial(draft, { pairing: null }).pairing).toBeNull();
    expect(mergeCommercial(draft, { pairing: '  ' }).pairing).toBeNull();
  });

  it('una sola portada: la primera marcada; no se elige ninguna por la bodega', () => {
    expect(
      mergeCommercial(EMPTY_COMMERCIAL_DRAFT, {
        imageKeys: [image('a'), image('b', true), image('c', true)],
      }).imageKeys.map((i) => i.isCover),
    ).toEqual([false, true, false]);
    expect(
      mergeCommercial(EMPTY_COMMERCIAL_DRAFT, {
        imageKeys: [image('a'), image('b')],
      }).imageKeys.some((i) => i.isCover),
    ).toBe(false);
  });

  it('una imagen repetida se detecta', () => {
    expect(
      duplicatedImageKeys({ imageKeys: [image('a'), image('b'), image('a')] }),
    ).toEqual(['a']);
    expect(duplicatedImageKeys({})).toEqual([]);
  });

  it('el borrador guardado se lee con su forma completa aunque venga vacío o roto', () => {
    expect(parseCommercialDraft({})).toEqual(EMPTY_COMMERCIAL_DRAFT);
    expect(parseCommercialDraft(null)).toEqual(EMPTY_COMMERCIAL_DRAFT);
    expect(
      parseCommercialDraft({ name: 7, imageKeys: [{ alt: 'sin key' }, 'x'] }),
    ).toEqual(EMPTY_COMMERCIAL_DRAFT);
  });

  it('para aprobar hacen falta nombre, descripción y portada: un detalle por campo', () => {
    expect(
      commercialMissing({ name: null, description: null, hasCover: false }),
    ).toEqual([
      expect.objectContaining({
        field: 'commercial.name',
        code: 'TOK_COMMERCIAL_DATA_INCOMPLETE',
      }),
      expect.objectContaining({ field: 'commercial.description' }),
      expect.objectContaining({ field: 'commercial.imageKeys' }),
    ]);
    expect(
      commercialMissing({ name: 'N', description: 'D', hasCover: true }),
    ).toEqual([]);
  });

  it('el slug sale del nombre: minúsculas, sin tildes ni signos', () => {
    expect(collectionSlug('Singani Gran Reserva 2026')).toBe(
      'singani-gran-reserva-2026',
    );
    expect(collectionSlug('  Añada «Única» · Edición Nº 1! ')).toBe(
      'anada-unica-edicion-n-1',
    );
    expect(collectionSlug('¡¡¡')).toBe('coleccion');
    expect(collectionSlug('a'.repeat(200))).toHaveLength(140);
  });

  it('el precio es un entero de centavos ≥ 1 en BOB; puede faltar', () => {
    expect(priceViolations(null)).toEqual([]);
    expect(priceViolations(undefined)).toEqual([]);
    expect(priceViolations({ amountMinor: 18000, currency: 'BOB' })).toEqual(
      [],
    );
    expect(
      priceViolations({ amountMinor: 10.5, currency: 'USD' }).map((v) => [
        v.field,
        v.code,
      ]),
    ).toEqual([
      ['price.amountMinor', 'TOK_PRICE_INVALID'],
      ['price.currency', 'TOK_PRICE_INVALID'],
    ]);
    expect(priceViolations({ amountMinor: 0, currency: 'BOB' })).toHaveLength(
      1,
    );
  });

  it('formatPrice escribe los centavos como bolivianos', () => {
    expect(formatPrice(18000)).toMatch(/^180,00 Bs$/);
  });
});

describe('Imágenes públicas de las colecciones (§5.5, U-5)', () => {
  it('la URL pública cuelga del origen de la API; sin origen, ruta relativa', () => {
    expect(publicCollectionImageUrl('https://api.example.test', 'abc')).toBe(
      'https://api.example.test/v1/public/collections/images/abc',
    );
    expect(publicCollectionImageUrl(null, 'abc')).toBe(
      '/v1/public/collections/images/abc',
    );
  });

  it('solo son públicas las de una colección que se llegó a publicar', () => {
    expect(collectionImagesArePublic({ publishedAt: null })).toBe(false);
    expect(collectionImagesArePublic({ publishedAt: new Date() })).toBe(true);
  });
});

describe('Utilidades de la emisión', () => {
  it('la clave de la intención es mint:{mintId}:{trozo}', () => {
    expect(mintIntentKey('m-1', 2)).toBe('mint:m-1:2');
  });

  it('stroops → XLM con 7 decimales', () => {
    expect(stroopsToXlm(0n)).toBe('0.0000000');
    expect(stroopsToXlm(1_389_000n)).toBe('0.1389000');
    expect(stroopsToXlm(65_000_000n)).toBe('6.5000000');
    expect(stroopsToXlm(12_345_678_901n)).toBe('1234.5678901');
  });
});

describe('Correos de la tokenización (§11)', () => {
  const variables: Record<string, string> = {
    nombre: 'Valeria Soliz',
    bodega: 'Destilería Cinti Viejo',
    lote: 'Singani Preventa 2026',
    cantidad: '100',
    cuota: '100',
    tipo: 'nueva',
    mensaje: 'Falta la nota de cata',
    motivo: 'Datos incompletos',
    coleccion: 'Singani Preventa 2026',
    estado: 'publicada',
    efecto: 'Ya está a la venta.',
    enlace: 'https://erp.example.test',
    botellas: '1–100',
    contrato: 'CDQX4AKGU76O7GH7F6SXPWGQ7YAVQTYPUYCSER67PWHJA3M7GIF6LACH',
    explorador: 'https://stellar.expert/explorer/testnet/contract/CDQX',
    emitidos: '100',
    faltante: '20',
    sinVender: '20',
    vendidos: '0',
    codigo: 'TOTAL_MINTED_MISMATCH',
    red: 'TESTNET',
    detectada: '2026-10-09T12:00:00.000Z',
  };

  it('las diez plantillas están registradas y se rinden con sus variables', () => {
    expect(TOKENIZATION_TEMPLATES.map((t) => t.name)).toEqual([
      'tokenizacion-recibida',
      'tokenizacion-nueva-operaciones',
      'tokenizacion-cambios',
      'tokenizacion-aprobada',
      'tokenizacion-rechazada',
      'coleccion-estado',
      'nft-emitidos',
      'faltante-detectado',
      'faltante-operaciones',
      'alerta-cadena',
    ]);
    const renderer = new MailRenderer();
    for (const template of TOKENIZATION_TEMPLATES) {
      expect(mailTemplate(template.name)).toBe(template);
      const used = Object.fromEntries(
        template.variables.map((name) => [name, variables[name]]),
      );
      const mail = renderer.render(template.name, used);
      expect(mail.subject.length).toBeGreaterThan(5);
      expect(mail.html).toContain('Valeria Soliz');
      expect(mail.text).not.toContain('{{');
    }
  });

  it('el mensaje de la bodega o de operaciones va escapado en el HTML', () => {
    const template = mailTemplate('tokenizacion-cambios')!;
    const mail = new MailRenderer().render(template.name, {
      nombre: 'Valeria',
      lote: 'Lote',
      mensaje: '<script>alert(1)</script>',
      enlace: 'https://erp.example.test',
    });
    expect(mail.html).not.toContain('<script>');
  });
});

describe('Procesadores de los eventos de la tokenización', () => {
  const reflector = new Reflector();

  it('hay un procesador por evento y la aprobación va por la cola chain', () => {
    const registered = TOKENIZATION_EVENT_HANDLERS.map((handler) =>
      reflector.get<{ queue: string; name: string }>(
        JOB_HANDLER_METADATA,
        handler,
      ),
    );
    expect(registered).toEqual([
      { queue: 'chain', name: 'tokenization.request_approved' },
      { queue: 'default', name: 'tokenization.request_submitted' },
      { queue: 'default', name: 'tokenization.request_changes_requested' },
      { queue: 'default', name: 'tokenization.request_rejected' },
      { queue: 'default', name: 'collection.published' },
      { queue: 'default', name: 'collection.paused' },
      { queue: 'default', name: 'collection.resumed' },
      { queue: 'default', name: 'collection.closed' },
      { queue: 'default', name: 'collection.minted' },
      { queue: 'default', name: 'collection.redeemable' },
    ]);
  });

  const job = (payload: Record<string, unknown>) => ({
    outboxEventId: 'evt-1',
    eventType: 'x',
    aggregateType: 'collection',
    aggregateId: 'c-1',
    correlationId: null,
    occurredAt: '2026-10-09T10:00:00.000Z',
    payload,
  });

  it('salvo el de la aprobación, procesar un evento solo deja constancia: no falla', async () => {
    for (const Handler of TOKENIZATION_EVENT_HANDLERS) {
      if (Handler === TokenizationRequestApprovedHandler) continue;
      const handler = new (
        Handler as unknown as new () => {
          handle(data: unknown): Promise<void>;
        }
      )();
      await expect(
        handler.handle(
          job({
            requestId: 'r-1',
            collectionId: 'c-1',
            slug: 'singani',
            status: 'PAUSED',
            system: true,
            quantity: 100,
          }),
        ),
      ).resolves.toBeUndefined();
    }
  });

  describe('tokenization.request_approved', () => {
    const payload = {
      requestId: 'r-1',
      wineryId: 'w-1',
      lotId: 'l-1',
      collectionId: 'c-1',
      mintId: 'm-1',
      kind: 'INITIAL',
      quantity: 100,
      resultingQuota: 100,
      mintSequence: 1,
      network: 'LOCAL',
      contractId: 'k-1',
      contractAddress: 'C1',
      toAddress: 'G1',
      lotArg: 'CVJ-L2026-004',
      publishOnMint: false,
      approvedBySystem: false,
      approvedByUserId: 'u-1',
      chunks: [
        {
          index: 1,
          amount: 100,
          firstBottleNumber: 1,
          lastBottleNumber: 100,
          intentKey: 'mint:m-1:1',
        },
      ],
    };
    const build = (mint: Record<string, unknown> | null) => {
      const tx = { mint: { findUnique: jest.fn().mockResolvedValue(mint) } };
      const prisma = {
        $transaction: jest.fn((work: (db: unknown) => unknown) => work(tx)),
      };
      const port = {
        registerMintIntents: jest.fn().mockResolvedValue(undefined),
      };
      const handler = new TokenizationRequestApprovedHandler(
        prisma as never,
        port as never,
      );
      return { handler, port, tx };
    };
    const mint = {
      id: 'm-1',
      requestId: 'r-1',
      collectionId: 'c-1',
      status: 'PENDING',
      quantity: 100,
      lotArg: 'CVJ-L2026-004',
      collection: { wineryId: 'w-1', lotId: 'l-1' },
    };

    it('registra por el puerto las intenciones MINT_BATCH de la emisión (una por trozo)', async () => {
      const { handler, port, tx } = build(mint);
      await handler.handle(job(payload) as never);
      expect(port.registerMintIntents).toHaveBeenCalledTimes(1);
      expect(port.registerMintIntents).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          mintId: 'm-1',
          wineryId: 'w-1',
          lotId: 'l-1',
          lotArg: 'CVJ-L2026-004',
          quantity: 100,
          chunks: payload.chunks,
          requestedBy: { userId: 'u-1', fullName: null, source: 'WORKER' },
        }),
      );
    });

    it('no registra nada si la emisión no existe, no es la del evento o ya se confirmó', async () => {
      for (const row of [
        null,
        { ...mint, requestId: 'otra' },
        { ...mint, collectionId: 'otra' },
        { ...mint, status: 'CONFIRMED' },
      ]) {
        const { handler, port } = build(row);
        await handler.handle(job(payload) as never);
        expect(port.registerMintIntents).not.toHaveBeenCalled();
      }
    });
  });
});
