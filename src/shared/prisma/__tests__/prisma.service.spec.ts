import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should implement ping method', async () => {
    // Mock de $queryRaw para test unitario aislado
    jest
      .spyOn(
        service as unknown as { $queryRaw: () => Promise<unknown> },
        '$queryRaw',
      )
      .mockResolvedValueOnce([{ '?column?': 1 }]);

    const isAlive = await service.ping();
    expect(isAlive).toBe(true);
  });

  it('should return false on ping failure', async () => {
    jest
      .spyOn(
        service as unknown as { $queryRaw: () => Promise<unknown> },
        '$queryRaw',
      )
      .mockRejectedValueOnce(new Error('DB connection failed'));

    const isAlive = await service.ping();
    expect(isAlive).toBe(false);
  });
});
