export interface OnchainStagePayload {
  batchId: string;
  stage: number;
  parents: string[];
  volumeOrUnits: number;
  metrics: number[];
  ipfsCidHash: string;
  timestamp: number;
}

export interface OnchainCertPayload {
  batchId: string;
  certifierAddress: string;
  reportIpfsCid: string;
  isApproved: boolean;
  timestamp: number;
}

export interface SimulatedAnchorResult {
  success: boolean;
  simulatedTxHash: string;
  batchId: string;
  payload: OnchainStagePayload | OnchainCertPayload;
  timestamp: string;
}

export interface IOnchainBatchAnchorHook {
  prepareStageAnchorPayload(
    stage: number,
    batchId: string,
    parents: string[],
    volumeOrUnits: number,
    metrics: number[],
    metadata: Record<string, any>,
  ): OnchainStagePayload;

  prepareCertificationPayload(
    batchId: string,
    certifierAddress: string,
    reportHash: string,
    isApproved: boolean,
  ): OnchainCertPayload;

  simulateAnchorExecution(
    payload: OnchainStagePayload | OnchainCertPayload,
  ): Promise<SimulatedAnchorResult>;
}
