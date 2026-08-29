import { HashUtil } from '../hash.util';

describe('HashUtil', () => {
  it('should generate a valid 64-char sha256 hex string', () => {
    const hash = HashUtil.sha256('drinks-on-chain-test');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should generate identical canonical hashes regardless of key order', () => {
    const objA = {
      b: 2,
      a: 1,
      nested: { y: 'second', x: 'first' },
      list: [1, 2, 3],
    };

    const objB = {
      nested: { x: 'first', y: 'second' },
      list: [1, 2, 3],
      a: 1,
      b: 2,
    };

    const hashA = HashUtil.sha256CanonicalJson(objA);
    const hashB = HashUtil.sha256CanonicalJson(objB);

    expect(hashA).toEqual(hashB);
  });

  it('should generate different hashes for different contents', () => {
    const hash1 = HashUtil.sha256CanonicalJson({ lot: 'LOT-001' });
    const hash2 = HashUtil.sha256CanonicalJson({ lot: 'LOT-002' });

    expect(hash1).not.toEqual(hash2);
  });
});
