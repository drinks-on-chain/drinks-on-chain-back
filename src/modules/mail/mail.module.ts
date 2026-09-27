import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { MailService } from './mail.service';

/**
 * Correo en la API: solo encola (`MailService.enqueue(tx, …)`). El envío lo
 * hace el worker (`jobs/mail-jobs.module.ts`). Ver
 * docs/arquitectura/correo-y-archivos.md.
 */
@Module({
  imports: [PrismaModule, OutboxModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
