import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: 'juan.perez@bodega.bo',
    description: 'Correo electrónico registrado del usuario',
  })
  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @IsNotEmpty({ message: 'El correo electrónico es requerido' })
  email!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Contraseña de la cuenta',
  })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña es requerida' })
  password!: string;
}
