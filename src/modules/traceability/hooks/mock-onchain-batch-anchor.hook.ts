import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  IOnchainBatchAnchorHook,
  OnchainStagePayload,
  OnchainCertPayload,
  SimulatedAnchorResult,
} from './interfaces/onchain-batch-anchor-hook.interface';

@Injectable()
export class MockOnchainBatchAnchorHook implements IOnchainBatchAnchorHook {
  private readonly logger = new Logger(MockOnchainBatchAnchorHook.name);

  prepareStageAnchorPayload(
    stage: number,
    batchId: string,
    parents: string[],
    volumeOrUnits: number,
    metrics: number[],
    metadata: Record<string, any>,
  ): OnchainStagePayload {
    const canonicalMetadata = JSON.stringify(metadata, Object.keys(metadata).sort());
    const ipfsCidHash = '0x' + crypto.createHash('sha256').update(canonicalMetadata).digest('hex');

    return {
      batchId: batchId.startsWith('0x') ? batchId : '0x' + crypto.createHash('sha256').update(batchId).digest('hex'),
      stage,
      parents: parents.map((p) => (p.startsWith('0x') ? p : '0x' + crypto.createHash('sha256').update(p).digest('hex'))),
      volumeOrUnits,
      metrics,
      ipfsCidHash,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  prepareCertificationPayload(
    batchId: string,
    certifierAddress: string,
    reportHash: string,
    isApproved: boolean,
  ): OnchainCertPayload {
    return {
      batchId: batchId.startsWith('0x') ? batchId : '0x' + crypto.createHash('sha256').update(batchId).digest('hex'),
      certifierAddress,
      reportIpfsCid: reportHash.startsWith('0x') ? reportHash : '0x' + crypto.createHash('sha256').update(reportHash).digest('hex'),
      isApproved,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  async simulateAnchorExecution(
    payload: OnchainStagePayload | OnchainCertPayload,
  ): Promise<SimulatedAnchorResult> {
    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    const simulatedTxHash = '0x' + payloadHash;

    this.logger.log(
      `[SIMULACIÓN ANCLAJE ON-CHAIN] Payload preparado para contrato trazabilidad.rs: batchId=${payload.batchId}, simulatedTx=${simulatedTxHash}`,
    );

    return {
      success: true,
      simulatedTxHash,
      batchId: payload.batchId,
      payload,
      timestamp: new Date().toISOString(),
    };
  }
}
