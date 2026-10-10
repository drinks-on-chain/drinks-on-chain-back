import { xdr } from '@stellar/stellar-sdk';
import { decodeEvent } from '../jobs/gateway/stellar-chain-gateway';
import { lotMintedOf } from '../jobs/handlers/mint-batch.handler';

/**
 * Ejemplos reales de la red local (pista SC, `integracion/eventos/*.json` del
 * repo de contratos, commit `3eb9ece`): los *topics* y el valor tal como los
 * devuelve el RPC, en base64.
 */
const CONTRACT = 'CDQX4AKGU76O7GH7F6SXPWGQ7YAVQTYPUYCSER67PWHJA3M7GIF6LACH';
const WINERY = 'GA7IRIRKT5YN5RKGY7B46VPMUICIIUJXBRCOS7TNQ4BPXVRMLM3ZDJBY';
const LOT_MINTED = {
  topic: [
    'AAAADwAAAApsb3RfbWludGVkAAA=',
    'AAAADgAAAA1DVkotTDIwMjYtMDA0AAAA',
    'AAAAEgAAAAAAAAAAPoiiKp9w3sVGx8PPVeyiBIRRNwxE6X5thwL71ixbN5E=',
  ],
  value:
    'AAAAEQAAAAEAAAADAAAADwAAAA5maXJzdF90b2tlbl9pZAAAAAAAAwAAAAAAAAAPAAAADWxhc3RfdG9rZW5faWQAAAAAAAADAAAAYwAAAA8AAAAGbWludGVyAAAAAAASAAAAAAAAAAA+iKIqn3DexUbHw89V7KIEhFE3DETpfm2HAvvWLFs3kQ==',
};
const CONSECUTIVE_MINT = {
  topic: [
    'AAAADwAAABBjb25zZWN1dGl2ZV9taW50',
    'AAAAEgAAAAAAAAAAPoiiKp9w3sVGx8PPVeyiBIRRNwxE6X5thwL71ixbN5E=',
  ],
  value:
    'AAAAEQAAAAEAAAACAAAADwAAAA1mcm9tX3Rva2VuX2lkAAAAAAAAAwAAAAAAAAAPAAAAC3RvX3Rva2VuX2lkAAAAAAMAAABj',
};

const decode = (event: { topic: string[]; value: string }) =>
  decodeEvent(
    event.topic.map((t) => xdr.ScVal.fromXDR(t, 'base64')),
    xdr.ScVal.fromXDR(event.value, 'base64'),
    CONTRACT,
  );

describe('Eventos del contrato (docs/funciones.md)', () => {
  it('decodifica lot_minted: lote y destino en los topics, rango y emisor en los datos', () => {
    expect(decode(LOT_MINTED)).toEqual({
      name: 'lot_minted',
      contractAddress: CONTRACT,
      topics: ['CVJ-L2026-004', WINERY],
      data: { first_token_id: 0, last_token_id: 99, minter: WINERY },
    });
  });

  it('decodifica consecutive_mint', () => {
    expect(decode(CONSECUTIVE_MINT)).toEqual({
      name: 'consecutive_mint',
      contractAddress: CONTRACT,
      topics: [WINERY],
      data: { from_token_id: 0, to_token_id: 99 },
    });
  });

  it('lotMintedOf saca el rango de la emisión de los eventos de la transacción', () => {
    const events = [decode(CONSECUTIVE_MINT), decode(LOT_MINTED)];
    expect(lotMintedOf(events, CONTRACT)).toEqual({
      lot: 'CVJ-L2026-004',
      to: WINERY,
      minter: WINERY,
      firstTokenId: 0,
      lastTokenId: 99,
    });
    // Sin lot_minted, o de otro contrato, no hay rango
    expect(lotMintedOf([decode(CONSECUTIVE_MINT)], CONTRACT)).toBeNull();
    expect(
      lotMintedOf(
        events,
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4',
      ),
    ).toBeNull();
    // Sin contrato conocido en el evento se acepta (una sola invocación)
    expect(
      lotMintedOf([{ ...decode(LOT_MINTED), contractAddress: null }], CONTRACT),
    ).not.toBeNull();
  });
});
