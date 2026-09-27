import { selectDemoPeople } from '../demo.seed';
import { loadMockFixtures } from '../fixtures';
import { mockId, platformMembershipId } from '../ids';

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

  it('los bloqueos de la Ola 1 corresponden a membresías bloqueadas', () => {
    for (const block of fx.memberBlocks) {
      const winery = fx.wineries.find((w) => w.id === block.organizationId);
      const member = winery?.members.find((m) => m.id === block.membershipId);
      expect(member?.isActive).toBe(false);
    }
  });
});
