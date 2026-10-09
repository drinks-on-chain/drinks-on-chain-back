import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Dirección con forma de StrKey (`G…`/`C…` + 55 de base32); no es de ninguna red. */
export function fakeStrKey(prefix: 'G' | 'C'): string {
  const bytes = randomBytes(55);
  let out = prefix;
  for (const byte of bytes) out += BASE32[byte % 32];
  return out;
}

export interface SeededChainIdentity {
  network: string;
  accountAddress: string;
  contractId: string;
  contractAddress: string;
  baseUri: string;
}

/**
 * Deja a una bodega con su identidad en la red `ACTIVE` en la base, como la
 * deja el paso 3.2 al confirmar la cuenta y el contrato: `chain_accounts`,
 * `nft_contracts` y sus dos transacciones `CONFIRMED`. No toca ninguna red:
 * es lo que lee el puerto de la tokenización.
 */
export async function seedChainIdentity(
  prisma: PrismaClient,
  params: {
    wineryId: string;
    winerySlug: string;
    symbol?: string;
    paused?: boolean;
    status?: 'ACTIVE' | 'PROVISIONING' | 'FAILED' | 'PAUSED';
  },
): Promise<SeededChainIdentity> {
  const network = (process.env.STELLAR_NETWORK ?? 'TESTNET').toUpperCase();
  const accountAddress = fakeStrKey('G');
  const contractAddress = fakeStrKey('C');
  const operator = fakeStrKey('G');
  const now = new Date();
  const tx = async (kind: string, subjectType: string) =>
    prisma.chainTransaction.create({
      data: {
        kind,
        status: 'CONFIRMED',
        network,
        intentKey: `e2e:${kind}:${params.wineryId}:${randomUUID()}`,
        subjectType,
        subjectId: params.wineryId,
        wineryId: params.wineryId,
        txHash: randomBytes(32).toString('hex'),
        ledger: 1234,
        confirmedAt: now,
        attempts: 1,
        feeChargedStroops: 100n,
      },
    });
  const createdTx = await tx('CREATE_WINERY_ACCOUNT', 'WINERY');
  const deployedTx = await tx('DEPLOY_WINERY_CONTRACT', 'CONTRACT');
  const account = await prisma.chainAccount.create({
    data: {
      role: 'WINERY',
      network,
      wineryId: params.wineryId,
      address: accountAddress,
      custodyKeyRef: `winery-${params.wineryId}`,
      status: params.status ?? 'ACTIVE',
      createdTxId: createdTx.id,
      confirmedAt: now,
    },
  });
  const baseUri = `http://localhost:4000/v1/public/nft/${params.winerySlug}/`;
  const contract = await prisma.nftContract.create({
    data: {
      wineryId: params.wineryId,
      chainAccountId: account.id,
      network,
      address: contractAddress,
      wasmHash: randomBytes(32).toString('hex'),
      name: 'Bodega e2e',
      symbol: params.symbol ?? 'E2E',
      baseUri,
      operatorAddress: operator,
      paused: params.paused ?? false,
      status: 'ACTIVE',
      deployedTxId: deployedTx.id,
      deployedAt: now,
      verifiedAt: now,
    },
  });
  await prisma.winery.update({
    where: { id: params.wineryId },
    data: { chainAccountId: account.id },
  });
  return {
    network,
    accountAddress,
    contractId: contract.id,
    contractAddress,
    baseUri,
  };
}

/**
 * Confirma en la base la emisión de una colección sin pasar por la red, como
 * hace el paso 3.4 al confirmarse cada `MINT_BATCH`: transacción `CONFIRMED`, rangos, los NFT en
 * `MINTED` a nombre de la bodega y la colección con `minted` al día (`READY`
 * si era su emisión inicial).
 */
export async function confirmMintInDatabase(
  prisma: PrismaClient,
  params: { mintId: string; firstTokenId: number; ownerAddress: string },
): Promise<{ txId: string }> {
  const mint = await prisma.mint.findUniqueOrThrow({
    where: { id: params.mintId },
    include: { collection: true },
  });
  const collection = mint.collection;
  const firstBottle = collection.minted + 1;
  const now = new Date();
  // La aprobación ya registró la intención del trozo (`mint:{id}:1`): se
  // confirma esa misma fila, como haría el firmante
  const confirmed = {
    status: 'CONFIRMED',
    txHash: randomBytes(32).toString('hex'),
    ledger: 2345,
    confirmedAt: now,
    attempts: 1,
    feeChargedStroops: 1_389_000n,
  };
  const tx = await prisma.chainTransaction.upsert({
    where: { intentKey: `mint:${mint.id}:1` },
    update: confirmed,
    create: {
      kind: 'MINT_BATCH',
      network: (process.env.STELLAR_NETWORK ?? 'TESTNET').toUpperCase(),
      intentKey: `mint:${mint.id}:1`,
      subjectType: 'MINT',
      subjectId: mint.id,
      wineryId: collection.wineryId,
      ...confirmed,
    },
  });
  await prisma.token.createMany({
    data: Array.from({ length: mint.quantity }, (_, i) => ({
      collectionId: collection.id,
      wineryId: collection.wineryId,
      lotId: collection.lotId,
      contractId: collection.contractId,
      tokenId: params.firstTokenId + i,
      bottleNumber: firstBottle + i,
      status: 'MINTED',
      ownerKind: 'WINERY',
      ownerAddress: params.ownerAddress,
      mintId: mint.id,
      mintTxId: tx.id,
    })),
  });
  await prisma.mint.update({
    where: { id: mint.id },
    data: {
      status: 'CONFIRMED',
      confirmedAt: now,
      ranges: [
        {
          firstTokenId: params.firstTokenId,
          lastTokenId: params.firstTokenId + mint.quantity - 1,
          firstBottleNumber: firstBottle,
          lastBottleNumber: firstBottle + mint.quantity - 1,
        },
      ],
    },
  });
  await prisma.collection.update({
    where: { id: collection.id },
    data: {
      minted: { increment: mint.quantity },
      pendingMintQuantity: { decrement: mint.quantity },
      mintStatus: 'CONFIRMED',
      ...(collection.status === 'MINTING' && { status: 'READY' }),
    },
  });
  return { txId: tx.id };
}
