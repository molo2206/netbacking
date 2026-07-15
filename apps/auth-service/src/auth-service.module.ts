// apps/auth-service/src/auth-service.module.ts
/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthServiceController } from './auth-service.controller';
import { AuthServiceService } from './auth-service.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { I18nModule } from '@app/common';
import { SmsService } from './sms/sms.service';
import { MailService } from './email/email.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET') || 'your_jwt_secret_here';
        // ✅ Utiliser 'as any' pour résoudre le problème de typage
        const expiresIn = configService.get<string>('JWT_EXPIRATION') || '14d';

        return {
          secret: secret,
          signOptions: {
            expiresIn: expiresIn as any, // ✅ Solution qui fonctionne avec toutes les versions
          },
        };
      },
      inject: [ConfigService],
    }),
    I18nModule,
  ],
  controllers: [AuthServiceController],
  providers: [
    AuthServiceService,
    JwtStrategy,
    LocalStrategy,
    SmsService,
    MailService,
  ],
  exports: [AuthServiceService],
})
export class AuthServiceModule {}