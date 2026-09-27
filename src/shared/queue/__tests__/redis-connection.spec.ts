import { buildRedisConnection } from '../redis-connection';

describe('buildRedisConnection', () => {
  it('lee host, puerto y contraseña de REDIS_URL', () => {
    expect(buildRedisConnection('redis://:s%40cret@redis:6380/2')).toEqual({
      host: 'redis',
      port: 6380,
      username: undefined,
      password: 's@cret',
      db: 2,
      tls: undefined,
      maxRetriesPerRequest: null,
    });
  });

  it('usa 6379 y la base 0 por defecto', () => {
    expect(buildRedisConnection('redis://localhost')).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: 0,
      password: undefined,
    });
  });

  it('activa TLS con rediss://', () => {
    expect(
      buildRedisConnection('rediss://user:pw@example.com:6390'),
    ).toMatchObject({ tls: {}, username: 'user', password: 'pw' });
  });

  it('rechaza otros esquemas', () => {
    expect(() => buildRedisConnection('http://localhost:6379')).toThrow(
      /redis/,
    );
  });
});
