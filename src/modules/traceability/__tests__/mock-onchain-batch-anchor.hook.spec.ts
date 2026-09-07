import { MockOnchainBatchAnchorHook } from '../hooks/mock-onchain-batch-anchor.hook';

describe('MockOnchainBatchAnchorHook', () => {
  let hook: MockOnchainBatchAnchorHook;

  beforeEach(() => {
    hook = new MockOnchainBatchAnchorHook();
  });

  it('debe preparar el payload de etapa formateando hashes en 0x', () => {
    const payload = hook.prepareStageAnchorPayload(
      1,
      'HARV-2026-01',
      ['PLOT-01'],
      14850,
      [2240, 345, 680],
      { brix: 22.4, ph: 3.45 },
    );

    expect(payload.batchId.startsWith('0x')).toBe(true);
    expect(payload.parents[0].startsWith('0x')).toBe(true);
    expect(payload.ipfsCidHash.startsWith('0x')).toBe(true);
    expect(payload.stage).toBe(1);
    expect(payload.volumeOrUnits).toBe(14850);
  });

  it('debe simular la ejecución on-chain retornando una transacción simulada', async () => {
    const payload = hook.prepareStageAnchorPayload(
      5,
      'BOTTLING-01',
      [],
      4080,
      [4000, 750],
      { lot: 'KUH-2026' },
    );

    const result = await hook.simulateAnchorExecution(payload);

    expect(result.success).toBe(true);
    expect(result.simulatedTxHash.startsWith('0x')).toBe(true);
    expect(result.batchId).toBe(payload.batchId);
  });
});
