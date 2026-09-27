import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@shared/prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto, AuthTokensDto } from './dto/auth-response.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { WalletsService } from '@modules/wallets/wallets.service';
import { WalletPurposeEnum, UserRoleEnum } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly bcryptRounds = 12;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly walletsService: WalletsService,
  ) {}

  /**
   * Registro de un nuevo usuario en la plataforma
   */
  async signup(dto: SignupDto): Promise<AuthResponseDto> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });

    if (existingUser) {
      throw new ConflictException(
        'El correo electrónico ya se encuentra registrado en el sistema',
      );
    }

    if (dto.phoneNumber) {
      const existingPhone = await this.prisma.user.findUnique({
        where: { phoneNumber: dto.phoneNumber.trim() },
      });
      if (existingPhone) {
        throw new ConflictException(
          'El número de teléfono ya se encuentra registrado',
        );
      }
    }

    const allowedPublicRoles: UserRoleEnum[] = [
      UserRoleEnum.CONSUMER,
      UserRoleEnum.WINERY_ADMIN,
    ];
    const targetRole = dto.userRole ?? UserRoleEnum.CONSUMER;

    if (!allowedPublicRoles.includes(targetRole)) {
      throw new ForbiddenException(
        `El rol '${targetRole}' no puede ser asignado mediante registro público. Los administradores globales se inicializan mediante Seeder y el personal operativo es incorporado por la bodega.`,
      );
    }

    // Hasheo de contraseña con bcrypt (cost factor 12)
    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase().trim(),
        passwordHash,
        fullName: dto.fullName.trim(),
        userRole: targetRole,
        phoneNumber: dto.phoneNumber?.trim() ?? null,
        preferredLocale: dto.preferredLocale ?? 'es',
        isActive: true,
      },
    });

    // Aprovisionamiento automático de billetera custodial
    await this.walletsService.provisionUserWallet(
      user.id,
      WalletPurposeEnum.CONSUMER_NFT,
    );

    this.logger.log(
      `Usuario registrado exitosamente: ${user.id} (${user.email})`,
    );

    const tokens = await this.generateTokens({
      sub: user.id,
      email: user.email,
      userRole: user.userRole,
      wineryId: null,
      memberRole: null,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        userRole: user.userRole,
        phoneNumber: user.phoneNumber,
        preferredLocale: user.preferredLocale,
        wineryId: null,
        memberRole: null,
      },
      tokens,
    };
  }

  /**
   * Autenticación de usuario con email y contraseña
   */
  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const email = dto.email.toLowerCase().trim();

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        wineryMemberships: {
          where: { isActive: true },
          take: 1,
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Credenciales de acceso inválidas');
    }

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales de acceso inválidas');
    }

    // Actualizar última fecha de inicio de sesión
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const activeMembership = user.wineryMemberships[0];
    const wineryId = activeMembership?.wineryId ?? null;
    const memberRole = activeMembership?.memberRole ?? null;

    const tokens = await this.generateTokens({
      sub: user.id,
      email: user.email,
      userRole: user.userRole,
      wineryId,
      memberRole,
    });

    this.logger.log(
      `Usuario autenticado exitosamente: ${user.id} (${user.email})`,
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        userRole: user.userRole,
        phoneNumber: user.phoneNumber,
        preferredLocale: user.preferredLocale,
        wineryId,
        memberRole,
      },
      tokens,
    };
  }

  /**
   * Renovación del par de tokens utilizando un refreshToken válido
   */
  async refreshTokens(refreshToken: string): Promise<AuthTokensDto> {
    try {
      const refreshSecret =
        this.configService.get<string>('JWT_REFRESH_SECRET');
      const payload: JwtPayload = this.jwtService.verify(refreshToken, {
        secret: refreshSecret,
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: {
          wineryMemberships: {
            where: { isActive: true },
            take: 1,
          },
        },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Usuario no encontrado o inactivo');
      }

      const activeMembership = user.wineryMemberships[0];
      const wineryId = activeMembership?.wineryId ?? null;
      const memberRole = activeMembership?.memberRole ?? null;

      return this.generateTokens({
        sub: user.id,
        email: user.email,
        userRole: user.userRole,
        wineryId,
        memberRole,
      });
    } catch {
      throw new UnauthorizedException(
        'Token de actualización inválido o expirado',
      );
    }
  }

  /**
   * Emisión del par de tokens JWT (AccessToken y RefreshToken)
   */
  private async generateTokens(payload: JwtPayload): Promise<AuthTokensDto> {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    const jwtExpiresIn =
      this.configService.get<string>('JWT_EXPIRES_IN') || '7d';
    const refreshSecret = this.configService.get<string>('JWT_REFRESH_SECRET');
    const refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '30d';

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: payload.sub,
          email: payload.email,
          userRole: payload.userRole,
          wineryId: payload.wineryId,
          memberRole: payload.memberRole,
        },
        {
          secret: jwtSecret,
          expiresIn: jwtExpiresIn as any,
        },
      ),
      this.jwtService.signAsync(
        {
          sub: payload.sub,
          email: payload.email,
          userRole: payload.userRole,
          wineryId: payload.wineryId,
          memberRole: payload.memberRole,
        },
        {
          secret: refreshSecret,
          expiresIn: refreshExpiresIn as any,
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 7 * 24 * 60 * 60, // 7 días en segundos
    };
  }
}
