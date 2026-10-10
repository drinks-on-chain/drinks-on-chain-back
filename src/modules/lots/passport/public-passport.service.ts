import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { REDIS_CLIENT } from '@shared/redis/redis.module';
import { redisReady } from '@shared/redis/redis-ready';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import {
  formatBottleCode,
  isValidBottleCode,
  normalizeBottleCode,
} from '../domain/bottle-code';
import { merkleProof, MerkleStep } from '../domain/merkle';
import { closedDossierLeaves, ClosedDossierLeaves } from '../lot-dossier';
import { dbClock } from '../trace-db';
import { publicLotAttachments } from '../views/lot-attachments.service';
import {
  toPublicDossierAnchor,
  verificationChecks,
} from '@modules/chain/anchor/anchor-view';
import { chainSettingsFromConfig } from '@modules/chain/chain.config';
import type { PublicDossierVerificationDto } from '@modules/chain/dto/chain.dto';
import { DOSSIER_HASH_ALGORITHM } from '../domain/dossier';
import { PassportLookupLimiter } from './passport-lookup-limiter';
import {
  buildLotPassport,
  PASSPORT_INCLUDE,
  PublicLotPassport,
} from './passport-view';

export interface PublicBottlePassport {
  kind: 'BOTTLE';
  bottle: {
    code: string;
    codeFormatted: string;
    serial: number;
    lotTotal: number;
    status: 'ACTIVE' | 'VOIDED';
    merkleProof: { salt: string; path: MerkleStep[] } | null;
  };
  lot: PublicLotPassport;
  redemption: null;
}

/** Respuesta del pasaporte con sus cabeceras de caché (§12.4). */
export interface PassportResponse<T> {
  body: T;
  etag: string;
  cacheControl: string;
}

/** Caché del pasaporte del lote en Redis (segundos). */
export const PASSPORT_CACHE_SECONDS = 60;
/** Los códigos inexistentes se recuerdan este tiempo (segundos). */
export const PASSPORT_NOT_FOUND_CACHE_SECONDS = 30;

export const PASSPORT_CACHE_CONTROL =
  'public, max-age=60, stale-while-revalidate=600';
/** Lote con el expediente cerrado: ya no cambia. */
export const PASSPORT_CACHE_CONTROL_CERTIFIED =
  'public, max-age=3600, stale-while-revalidate=600';
export const PASSPORT_NOT_FOUND_CACHE_CONTROL = `public, max-age=${PASSPORT_NOT_FOUND_CACHE_SECONDS}`;

/** Forma de un código de lote (`CVJ-2026-SINGANI-004` y los anteriores a la Ola 2). */
const LOT_CODE_PATTERN = /^[A-Z0-9]{1,20}(-[A-Z0-9]{1,20}){2,6}$/;
const MAX_CODE_LENGTH = 100;

/** Normaliza un código de lote (mayúsculas, sin espacios) o `null` si su forma es imposible. */
export function normalizeLotCode(input: string): string | null {
  const code = (input ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return code.length <= MAX_CODE_LENGTH && LOT_CODE_PATTERN.test(code)
    ? code
    : null;
}

/**
 * Qué es un código del visor (§12.1): de botella (8 caracteres Crockford con
 * control, tras normalizar), de lote, o imposible.
 */
export function classifyPassportCode(
  input: string,
):
  | { kind: 'BOTTLE'; code: string }
  | { kind: 'LOT'; code: string }
  | { kind: 'MALFORMED' } {
  const raw = (input ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_CODE_LENGTH) {
    return { kind: 'MALFORMED' };
  }
  const bottle = normalizeBottleCode(raw);
  if (isValidBottleCode(bottle)) return { kind: 'BOTTLE', code: bottle };
  const lot = normalizeLotCode(raw);
  return lot ? { kind: 'LOT', code: lot } : { kind: 'MALFORMED' };
}

interface LotStamp {
  id: string;
  lotCode: string;
  stage: string;
  stamp: string;
}

/** Hojas de la raíz de un expediente cerrado, con la posición de cada código. */
interface MerkleTree {
  closed: ClosedDossierLeaves;
  index: Map<string, number>;
}

const MERKLE_TREES_KEPT = 4;

/**
 * Pasaporte público de lotes y botellas (contrato O2 §12; PUB-01, PUB-02,
 * PUB-05; EA-05): solo datos registrados, 404 uniforme, freno a la
 * enumeración y caché.
 *
 * La caché de Redis guarda el pasaporte del lote 60 s con una **marca** de su
 * estado (último evento de la línea de tiempo, última escritura, etapa,
 * estado de la bodega y del expediente): cualquier evento del lote la cambia
 * y la entrada deja de servir, sin depender de que quien escribe avise.
 */
@Injectable()
export class PublicPassportService {
  private readonly logger = new Logger(PublicPassportService.name);
  private readonly trees = new Map<string, MerkleTree | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: PassportLookupLimiter,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
  ) {}

  /** `GET /v1/public/passports/{code}`: botella o lote según el código. */
  async resolve(
    input: string,
    ip: string | null,
  ): Promise<PassportResponse<PublicLotPassport | PublicBottlePassport>> {
    await this.limiter.assertAllowed(ip);
    const parsed = classifyPassportCode(input);
    if (parsed.kind === 'MALFORMED') throw this.malformed();
    return parsed.kind === 'BOTTLE'
      ? this.bottleByCode(parsed.code, ip)
      : this.lotByCode(parsed.code, ip);
  }

  /** `GET /v1/public/lots/{lotCode}`. */
  async lot(
    input: string,
    ip: string | null,
  ): Promise<PassportResponse<PublicLotPassport>> {
    await this.limiter.assertAllowed(ip);
    const code = normalizeLotCode(input);
    if (!code) throw this.malformed();
    return this.lotByCode(code, ip);
  }

  /** `GET /v1/public/bottles/{code}`. */
  async bottle(
    input: string,
    ip: string | null,
  ): Promise<PassportResponse<PublicBottlePassport>> {
    await this.limiter.assertAllowed(ip);
    const code = normalizeBottleCode((input ?? '').slice(0, MAX_CODE_LENGTH));
    if (!isValidBottleCode(code)) throw this.malformed();
    return this.bottleByCode(code, ip);
  }

  /** Bytes canónicos del expediente cerrado (`GET …/lots/{lotCode}/dossier`). */
  async dossier(
    input: string,
    ip: string | null,
  ): Promise<{ canonical: string; hash: string }> {
    await this.limiter.assertAllowed(ip);
    const code = normalizeLotCode(input);
    if (!code) throw this.malformed();
    const lot = await this.prisma.lot.findUnique({
      where: { lotCode: code },
      select: {
        dossier: { select: { status: true, canonical: true, hash: true } },
      },
    });
    if (!lot) throw await this.miss(`lot:${code}`, ip);
    const dossier = lot.dossier;
    if (dossier?.status !== 'CLOSED' || !dossier.canonical || !dossier.hash) {
      throw this.notFound();
    }
    return { canonical: dossier.canonical, hash: dossier.hash };
  }

  /**
   * `GET /v1/public/lots/{lotCode}/verification` (contrato O3 §7.3, PUB-03):
   * huella del expediente, anclaje y las cuatro comprobaciones. Lo que el
   * servidor comprobó en la red al confirmar queda en `verifiedOnChainAt`; el
   * visor recalcula la huella con los bytes de `…/dossier`.
   */
  async verification(
    input: string,
    ip: string | null,
  ): Promise<PassportResponse<PublicDossierVerificationDto>> {
    await this.limiter.assertAllowed(ip);
    const code = normalizeLotCode(input);
    if (!code) throw this.malformed();
    const key = `lot:${code}`;
    if (await this.knownMissing(key)) throw await this.miss(key, ip, false);
    const lot = await this.prisma.lot.findUnique({
      where: { lotCode: code },
      select: {
        id: true,
        stage: true,
        dossier: {
          select: {
            status: true,
            hash: true,
            closedAt: true,
            anchor: true,
          },
        },
      },
    });
    if (!lot) throw await this.miss(key, ip);
    const chain = chainSettingsFromConfig(this.config);
    const official = await this.prisma.chainAccount.findFirst({
      where: {
        role: 'ANCHOR',
        network: chain.network,
        address: { not: null },
      },
      select: { address: true },
    });
    const closed = lot.dossier?.status === 'CLOSED' && !!lot.dossier.hash;
    const hash = closed ? (lot.dossier?.hash ?? null) : null;
    const anchorRow = closed ? (lot.dossier?.anchor ?? null) : null;
    const anchor = toPublicDossierAnchor(anchorRow, chain.explorerBaseUrl);
    const base = (this.config.get<string>('API_PUBLIC_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    const body: PublicDossierVerificationDto = {
      lotCode: code,
      dossier: {
        status: closed ? 'CLOSED' : 'OPEN',
        hash,
        algorithm: DOSSIER_HASH_ALGORITHM,
        closedAt: closed
          ? (lot.dossier?.closedAt?.toISOString() ?? null)
          : null,
        canonicalUrl: closed
          ? `${base}/v1/public/lots/${encodeURIComponent(code)}/dossier`
          : null,
      },
      anchor,
      officialAnchorAccount: official?.address ?? null,
      checks: verificationChecks({
        dossierHash: hash,
        anchor: anchorRow,
        officialAnchorAccount: official?.address ?? null,
      }),
      verifiedOnChainAt:
        anchor?.status === 'ANCHORED'
          ? (anchorRow?.verifiedAt?.toISOString() ?? null)
          : null,
      checkedAt: new Date().toISOString(),
    };
    return {
      body,
      etag: this.etag(
        `verification|${lot.id}|${hash ?? ''}|${anchorRow?.status ?? ''}|${anchorRow?.txHash ?? ''}|${official?.address ?? ''}`,
      ),
      // Anclado y verificado ya no cambia (§7.3)
      cacheControl:
        anchor?.status === 'ANCHORED'
          ? PASSPORT_CACHE_CONTROL_CERTIFIED
          : PASSPORT_CACHE_CONTROL,
    };
  }

  private explorerBaseUrl(): string | null {
    return chainSettingsFromConfig(this.config).explorerBaseUrl;
  }

  /** URL firmada de un adjunto público (`GET …/lots/{lotCode}/attachments/{id}`). */
  async attachmentUrl(
    input: string,
    attachmentId: string,
    ip: string | null,
  ): Promise<string> {
    await this.limiter.assertAllowed(ip);
    const code = normalizeLotCode(input);
    if (!code) throw this.malformed();
    const lot = await this.prisma.lot.findUnique({
      where: { lotCode: code },
      select: { id: true },
    });
    if (!lot) throw await this.miss(`lot:${code}`, ip);
    const attachment = (await publicLotAttachments(this.prisma, lot.id)).find(
      (a) => a.id === attachmentId,
    );
    if (!attachment || !(await this.storage.exists(attachment.key))) {
      throw this.notFound();
    }
    const signed = await this.storage.getSignedUrl(
      attachment.key,
      DEFAULT_SIGNED_URL_TTL_SECONDS,
    );
    return signed.url;
  }

  // ── Lote ─────────────────────────────────────────────────────────────────

  private async lotByCode(
    code: string,
    ip: string | null,
  ): Promise<PassportResponse<PublicLotPassport>> {
    const key = `lot:${code}`;
    if (await this.knownMissing(key)) throw await this.miss(key, ip, false);
    const stamp = await this.lotStamp({ lotCode: code });
    if (!stamp) throw await this.miss(key, ip);
    const body = await this.lotPassport(stamp);
    return {
      body,
      etag: this.etag(`lot|${stamp.stamp}`),
      cacheControl:
        body.stage === 'CERTIFIED' || body.stage === 'ANCHORED'
          ? PASSPORT_CACHE_CONTROL_CERTIFIED
          : PASSPORT_CACHE_CONTROL,
    };
  }

  /** Marca del estado del lote: cambia con cada evento o escritura que lo toca. */
  private async lotStamp(
    where: { lotCode: string } | { id: string },
  ): Promise<LotStamp | null> {
    const lot = await this.prisma.lot.findUnique({
      where,
      select: {
        id: true,
        lotCode: true,
        stage: true,
        updatedAt: true,
        winery: { select: { certificationStatus: true, updatedAt: true } },
        dossier: {
          select: {
            status: true,
            hash: true,
            anchor: { select: { status: true, txHash: true } },
          },
        },
        events: { orderBy: { seq: 'desc' }, take: 1, select: { seq: true } },
      },
    });
    // Solo existen pasaportes de lotes con código de lote (embotellados)
    if (!lot || !lot.lotCode) return null;
    return {
      id: lot.id,
      lotCode: lot.lotCode,
      stage: lot.stage,
      stamp: [
        lot.id,
        lot.updatedAt.getTime(),
        lot.events[0]?.seq ?? 0,
        lot.stage,
        lot.winery.certificationStatus,
        lot.winery.updatedAt.getTime(),
        lot.dossier?.status ?? 'OPEN',
        lot.dossier?.hash ?? '',
        lot.dossier?.anchor?.status ?? '',
        lot.dossier?.anchor?.txHash ?? '',
      ].join(':'),
    };
  }

  private async lotPassport(stamp: LotStamp): Promise<PublicLotPassport> {
    const cacheKey = `passport:lot:${stamp.id}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) {
      try {
        const entry = JSON.parse(cached) as {
          stamp: string;
          passport: PublicLotPassport;
        };
        if (entry.stamp === stamp.stamp) return entry.passport;
      } catch {
        // Entrada ilegible: se reconstruye
      }
    }
    const passport = await this.buildPassport(stamp.id);
    await this.cacheSet(
      cacheKey,
      JSON.stringify({ stamp: stamp.stamp, passport }),
      PASSPORT_CACHE_SECONDS,
    );
    return passport;
  }

  private async buildPassport(lotId: string): Promise<PublicLotPassport> {
    const [lot, clock, corrections, voids, attachments] = await Promise.all([
      this.prisma.lot.findUniqueOrThrow({
        where: { id: lotId },
        include: PASSPORT_INCLUDE,
      }),
      dbClock(this.prisma),
      this.prisma.traceCorrection.aggregate({
        where: { lotId },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.traceCorrection.findMany({
        where: { lotId, kind: 'VOID' },
        select: { targetId: true },
      }),
      publicLotAttachments(this.prisma, lotId),
    ]);
    const memberships = [
      ...new Set(
        lot.events
          .map((e) => e.actorMembershipId)
          .filter((id): id is string => !!id),
      ),
    ];
    const roles = new Map(
      memberships.length > 0
        ? (
            await this.prisma.membership.findMany({
              where: { id: { in: memberships } },
              select: { id: true, role: true },
            })
          ).map((m) => [m.id, m.role as string])
        : [],
    );
    const base = (this.config.get<string>('API_PUBLIC_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    return buildLotPassport(lot, {
      today: clock.today,
      now: clock.now,
      roles,
      corrections: {
        count: corrections._count._all,
        lastAt: corrections._max.createdAt,
      },
      voidedRecordIds: new Set(voids.map((v) => v.targetId)),
      attachments,
      publicUrl: (path) => `${base}${path}`,
      explorerBaseUrl: this.explorerBaseUrl(),
    });
  }

  // ── Botella ──────────────────────────────────────────────────────────────

  private async bottleByCode(
    code: string,
    ip: string | null,
  ): Promise<PassportResponse<PublicBottlePassport>> {
    const key = `bottle:${code}`;
    if (await this.knownMissing(key)) throw await this.miss(key, ip, false);
    const unit = await this.prisma.bottleUnit.findUnique({
      where: { code },
      select: {
        code: true,
        serial: true,
        status: true,
        lotId: true,
        bottlingBatch: { select: { totalBottlesPackaged: true } },
      },
    });
    const stamp = unit ? await this.lotStamp({ id: unit.lotId }) : null;
    if (!unit || !stamp) throw await this.miss(key, ip);
    const lot = await this.lotPassport(stamp);
    const proof =
      lot.dossier.status === 'CLOSED'
        ? await this.merkleProofOf(unit.lotId, unit.code)
        : null;
    const status = unit.status === 'VOIDED' ? 'VOIDED' : 'ACTIVE';
    return {
      body: {
        kind: 'BOTTLE',
        bottle: {
          code: unit.code,
          codeFormatted: formatBottleCode(unit.code),
          serial: unit.serial,
          lotTotal: unit.bottlingBatch.totalBottlesPackaged,
          status,
          merkleProof: proof,
        },
        lot,
        redemption: null,
      },
      etag: this.etag(
        `bottle|${unit.code}|${status}|${proof ? 'proof' : 'no-proof'}|${stamp.stamp}`,
      ),
      // Un código se puede anular con el expediente cerrado (S-14): el aviso
      // de "código anulado" no espera una hora
      cacheControl: PASSPORT_CACHE_CONTROL,
    };
  }

  /**
   * Prueba Merkle del código contra la raíz que guardó el cierre del
   * expediente (`lot_dossiers.bottle_merkle_root`), con la construcción única
   * de `domain/merkle` (`sha256-merkle/serial-code-salt`). Las hojas son los
   * códigos que estaban activos al cerrar (`closedDossierLeaves`): un código
   * anulado **antes** del cierre no tiene prueba; uno anulado **después**
   * (S-14) la conserva, porque formó parte de la raíz.
   *
   * Las hojas de un expediente cerrado no cambian (tras el cierre no se
   * emiten códigos), así que se guardan en memoria por lote y raíz.
   */
  private async merkleProofOf(
    lotId: string,
    code: string,
  ): Promise<{ salt: string; path: MerkleStep[] } | null> {
    const dossier = await this.prisma.lotDossier.findUnique({
      where: { lotId },
      select: { status: true, bottleMerkleRoot: true },
    });
    const root = dossier?.bottleMerkleRoot;
    if (dossier?.status !== 'CLOSED' || !root) return null;

    const treeKey = `${lotId}:${root}`;
    let tree = this.trees.get(treeKey);
    if (tree === undefined) {
      const closed = await closedDossierLeaves(this.prisma, lotId);
      if (!closed) {
        this.logger.warn(
          `La raíz Merkle del expediente del lote ${lotId} no se pudo reproducir: el pasaporte no publica la prueba`,
        );
      }
      tree = closed
        ? {
            closed,
            index: new Map(closed.units.map((u, i) => [u.code, i])),
          }
        : null;
      this.trees.set(treeKey, tree);
      if (this.trees.size > MERKLE_TREES_KEPT) {
        this.trees.delete(this.trees.keys().next().value as string);
      }
    }
    if (!tree) return null;
    const index = tree.index.get(code);
    if (index === undefined) return null;
    return {
      salt: tree.closed.units[index].salt,
      path: merkleProof(tree.closed.leaves, index),
    };
  }

  // ── Errores, límites y caché ─────────────────────────────────────────────

  /** 404 uniforme: no distingue botella de lote ni dice por qué no está. */
  private notFound(): AppException {
    return new AppException(
      404,
      ErrorCode.PUB_CODE_NOT_FOUND,
      'Código no encontrado',
    );
  }

  private malformed(): AppException {
    return new AppException(
      422,
      ErrorCode.PUB_CODE_MALFORMED,
      'El código no tiene una forma válida: revisa los caracteres',
      [
        {
          field: 'code',
          message: 'Código imposible o con el control inválido',
        },
      ],
    );
  }

  /**
   * Código inexistente: se recuerda 30 s, cuenta para el freno de la IP (que
   * puede responder 429 en lugar del 404) y devuelve el 404 uniforme.
   */
  private async miss(
    key: string,
    ip: string | null,
    remember = true,
  ): Promise<AppException> {
    if (remember) {
      await this.cacheSet(
        `passport:missing:${key}`,
        '1',
        PASSPORT_NOT_FOUND_CACHE_SECONDS,
      );
    }
    await this.limiter.registerMiss(ip);
    return this.notFound();
  }

  private async knownMissing(key: string): Promise<boolean> {
    return (await this.cacheGet(`passport:missing:${key}`)) !== null;
  }

  private etag(seed: string): string {
    return `W/"${createHash('sha256').update(seed).digest('hex').slice(0, 32)}"`;
  }

  private async cacheGet(key: string): Promise<string | null> {
    try {
      if (await redisReady(this.redis)) return await this.redis.get(key);
    } catch {
      // Sin caché: se responde desde la base
    }
    return null;
  }

  private async cacheSet(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      if (await redisReady(this.redis)) {
        await this.redis.set(key, value, 'EX', ttlSeconds);
      }
    } catch {
      // Sin caché: la siguiente petición vuelve a construirlo
    }
  }
}
