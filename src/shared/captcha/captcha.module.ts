import { Global, Module } from '@nestjs/common';
import { CaptchaService } from './captcha.service';

/**
 * Captcha de los formularios públicos (Turnstile). Global: lo usan la
 * recuperación de contraseña, la verificación del correo y las solicitudes de
 * alta.
 */
@Global()
@Module({
  providers: [CaptchaService],
  exports: [CaptchaService],
})
export class CaptchaModule {}
