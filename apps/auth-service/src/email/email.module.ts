// apps/auth-service/src/email/email.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailService } from './email.service';

/**
 * Module d'envoi d'emails AccesFinance.
 * ⚠️ L'ancien MailerModule (@nestjs-modules/mailer, variables SMTP_*) a été retiré :
 *    il n'était utilisé nulle part et pouvait masquer la vraie configuration.
 *    Tout passe par MailService (nodemailer, variables MAILER_*).
 */
@Module({
  imports: [ConfigModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
