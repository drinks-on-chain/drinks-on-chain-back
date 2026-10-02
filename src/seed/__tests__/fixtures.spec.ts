import { applySeedCorrections, EMPTY_TANK_IDS } from '../corrections';
import { selectDemoPeople } from '../demo.seed';
import { FixtureActor, loadMockFixtures } from '../fixtures';
import { lotIdOfHarvest, mockId, platformMembershipId } from '../ids';

/**
 * Los fixtures copiados de los mocks son coherentes con lo que la semilla
 * espera: mismos UUID v5 y toda referencia apunta a algo que se crea.
 */
describe('fixtures de la semilla', () => {
  const fx = loadMockFixtures();
  const people = selectDemoPeople(fx);
  const included = new Set(people.included.map((u) => u.id));
  const seededMembers = new Map(
    fx.wineries.flatMap((w) =>
      w.members.filter((m) => included.has(m.userId)).map((m) => [m.id, w.id]),
    ),
  );

  it('sin contraseñas de los mocks', () => {
    for (const user of fx.users) {
      expect(user._mock).not.toHaveProperty('password');
    }
  });

  it('ids = UUID v5 de los mocks con el mismo espacio de nombres', () => {
    const keys = [
      'altos',
      'cintiviejo',
      'guadalquivir',
      'uriondo',
      'padcaya',
      'valle',
    ];
    expect(fx.wineries.map((w) => w.id).sort()).toEqual(
      keys.map((k) => mockId(`winery:${k}`)).sort(),
    );
    for (const user of fx.users) {
      expect(user.id).toBe(mockId(`user:${user._mock.key}`));
    }
    expect(platformMembershipId(mockId('user:soporte'))).toBe(
      mockId(`membership:platform:${mockId('user:soporte')}`),
    );
  });

  it('personal interno ADMIN, OPERATIONS y SUPPORT y personas de bodega; sin SUPERADMIN, consumidores ni cajero', () => {
    const byEmail = new Map(people.included.map((u) => [u.email, u]));
    expect(byEmail.get('administracion@drinksonchain.test')?._mock).toEqual(
      expect.objectContaining({ platformRole: 'ADMIN' }),
    );
    expect(byEmail.has('sofia@aramayo.test')).toBe(true);
    expect(people.skipped.map((s) => s.user.email).sort()).toEqual(
      [
        'cajero.lacava@drinksonchain.test',
        'carlos@tribu.test',
        'gestor@drinksonchain.test',
        'maria@tribu.test',
      ].sort(),
    );
  });

  it('toda autoría de la trazabilidad es un miembro que se crea, de la misma bodega', () => {
    const refs: [string | null, string][] = [
      ...fx.harvestBatches.map(
        (h) => [h.certifiedByMemberId, h.wineryId] as [string | null, string],
      ),
      ...fx.bottlingBatches.map(
        (b) => [b.releasedByMemberId, b.wineryId] as [string | null, string],
      ),
    ];
    const tankWinery = new Map(
      fx.fermentationTanks.map((t) => [t.id, t.wineryId]),
    );
    const bottlingWinery = new Map(
      fx.bottlingBatches.map((b) => [b.id, b.wineryId]),
    );
    for (const log of fx.fermentationLogs) {
      refs.push([
        log.recordedByMemberId,
        tankWinery.get(log.fermentationTankId)!,
      ]);
    }
    for (const lab of fx.labAnalyses) {
      refs.push([
        lab.reviewedByMemberId,
        bottlingWinery.get(lab.bottlingBatchId)!,
      ]);
    }
    for (const [memberId, wineryId] of refs) {
      if (memberId === null) continue;
      expect(seededMembers.get(memberId)).toBe(wineryId);
    }
  });

  describe('lotes de la Ola 2 (mocks 0.5.0) con las correcciones de realismo', () => {
    const seeded = applySeedCorrections(fx);
    const lotIds = new Set(seeded.lots.map((l) => l.id));

    it('toda la cadena pertenece a un lote que se siembra; solo un pesaje queda sin lote', () => {
      for (const row of [
        ...seeded.fermentationTanks,
        ...seeded.wineAgings,
        ...seeded.productionBatches,
        ...seeded.bottlingBatches,
        ...seeded.labAnalyses,
        ...seeded.lotEvents,
      ]) {
        expect(lotIds.has(row.lotId)).toBe(true);
      }
      const loose = seeded.harvestBatches.filter((h) => h.lotId === null);
      expect(loose).toHaveLength(1);
      expect(
        seeded.harvestBatches.every(
          (h) => h.lotId === null || lotIds.has(h.lotId),
        ),
      ).toBe(true);
      // Los lotes migrados conservan el id que deriva de su pesaje
      for (const h of seeded.harvestBatches) {
        const lot = seeded.lots.find((l) => l.id === h.lotId);
        if (lot?.rules.origin === 'MIGRATION') {
          expect(h.lotId).toBe(lotIdOfHarvest(h.id));
        }
      }
    });

    it('un lote en cada etapa y uno con el expediente cerrado', () => {
      expect(new Set(seeded.lots.map((l) => l.stage))).toEqual(
        new Set([
          'ORIGIN',
          'HARVEST',
          'FERMENTING',
          'AGING',
          'DISTILLING',
          'RESTING',
          'BOTTLED',
          'CERTIFIED',
          'REJECTED',
          'DISCARDED',
        ]),
      );
      expect(
        seeded.lots
          .filter((l) => l.dossierStatus === 'CLOSED')
          .map((l) => [l.name, l.stage, l.lotCode]),
      ).toEqual([
        ['Singani Gran Reserva 2026', 'CERTIFIED', 'CVJ-2026-SINGANI-004'],
      ]);
    });

    it('quien aparece como autor es una membresía que se crea, de la bodega del lote', () => {
      const wineryOfLot = new Map(seeded.lots.map((l) => [l.id, l.wineryId]));
      const wineryOfHarvest = new Map(
        seeded.harvestBatches.map((h) => [h.id, h.wineryId]),
      );
      const refs: [FixtureActor | null | undefined, string | undefined][] = [
        ...seeded.lots.flatMap((l) => [
          [l.createdBy, l.wineryId] as [FixtureActor | null, string],
          [l.discarded?.by, l.wineryId] as [FixtureActor | null, string],
        ]),
        ...seeded.lotEvents.map(
          (e) =>
            [e.actor, wineryOfLot.get(e.lotId)] as [
              FixtureActor | null,
              string,
            ],
        ),
        ...seeded.maturityAnalyses.map(
          (m) =>
            [m.recordedBy, wineryOfHarvest.get(m.harvestBatchId)] as [
              FixtureActor | null,
              string,
            ],
        ),
        ...seeded.phytoDecisions.map(
          (d) =>
            [d.decidedBy, wineryOfHarvest.get(d.harvestBatchId)] as [
              FixtureActor | null,
              string,
            ],
        ),
        ...seeded.fermentationTanks.flatMap((t) =>
          (t.transitions ?? []).map(
            (tr) => [tr.by, t.wineryId] as [FixtureActor | null, string],
          ),
        ),
      ];
      for (const [actor, wineryId] of refs) {
        if (!actor) continue;
        expect(seededMembers.get(actor.membershipId)).toBe(wineryId);
      }
    });

    it('correcciones: sin tanques vacíos, TK-08 transferido, un tanque limpio y eventos renumerados', () => {
      expect(
        fx.fermentationTanks.filter((t) => EMPTY_TANK_IDS.includes(t.id)),
      ).toHaveLength(3);
      expect(
        seeded.fermentationTanks.filter(
          (t) =>
            EMPTY_TANK_IDS.includes(t.id) ||
            !(Number(t.volumeFilledLiters) > 0),
        ),
      ).toEqual([]);
      const byCode = (wineryKey: string, code: string) =>
        seeded.fermentationTanks.find(
          (t) =>
            t.wineryId === mockId(`winery:${wineryKey}`) && t.tankCode === code,
        );
      expect(byCode('cintiviejo', 'TK-08')?.status).toBe('TRANSFERRED');
      expect(byCode('cintiviejo', 'TK-01')?.status).toBe('CLEANED');
      // Un tanque con entradas solo usa los kilos de su pesaje
      for (const h of seeded.harvestBatches) {
        const used = seeded.fermentationTanks
          .flatMap((t) => t.inputs)
          .filter((i) => i.harvestBatchId === h.id)
          .reduce((n, i) => n + i.kg, 0);
        expect(used).toBeLessThanOrEqual(h.netWeightKg);
      }
      // Ningún evento apunta a un tanque retirado y `seq` es consecutivo por lote
      expect(
        seeded.lotEvents.filter((e) => EMPTY_TANK_IDS.includes(e.resource.id)),
      ).toEqual([]);
      const perLot = new Map<string, number[]>();
      for (const e of seeded.lotEvents) {
        perLot.set(e.lotId, [...(perLot.get(e.lotId) ?? []), e.seq]);
      }
      for (const seqs of perLot.values()) {
        expect([...seqs].sort((a, b) => a - b)).toEqual(
          seqs.map((_, i) => i + 1),
        );
      }
      // Cada lote tiene su línea de tiempo (empieza por su creación)
      for (const lot of seeded.lots) {
        expect(perLot.get(lot.id)?.length ?? 0).toBeGreaterThan(0);
      }
    });
  });

  it('los bloqueos de la Ola 1 corresponden a membresías bloqueadas', () => {
    for (const block of fx.memberBlocks) {
      const winery = fx.wineries.find((w) => w.id === block.organizationId);
      const member = winery?.members.find((m) => m.id === block.membershipId);
      expect(member?.isActive).toBe(false);
    }
  });
});
