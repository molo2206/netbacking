// apps/api-gateway/src/api-gateway.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { I18nModule } from '@app/common';
import { JwtAuthGuard } from 'apps/auth-service/src/guards/jwt-auth.guard';

@Module({
  imports: [
    // ==========================================
    // CONFIGURATION
    // ==========================================
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // ==========================================
    // JWT MODULE - Pour l'authentification
    // ==========================================
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'secret',
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRATION') || '30d',
        } as any,
      }),
      inject: [ConfigService],
    }),

    // ==========================================
    // MICROSERVICES CLIENTS
    // ==========================================
    ClientsModule.register([
      // Auth Service
      {
        name: 'AUTH_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.AUTH_QUEUE || 'auth_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // User Service
      {
        name: 'USER_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.USER_QUEUE || 'user_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // Transaction Service
      {
        name: 'TRANSACTION_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.TRANSACTION_QUEUE || 'transaction_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // Netbacking Service
      {
        name: 'NETBACKING_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.NETBACKING_QUEUE || 'netbacking_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // Mobile Banking Service
      {
        name: 'MOBILE_BANKING_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.MOBILE_BANKING_QUEUE || 'mobile_banking_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // Notification Service
      {
        name: 'NOTIFICATION_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.NOTIFICATION_QUEUE || 'notification_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // Audit Service
      {
        name: 'AUDIT_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.AUDIT_QUEUE || 'audit_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // KYC Service
      {
        name: 'KYC_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.KYC_QUEUE || 'kyc_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // Settings Service
      {
        name: 'SETTINGS_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.SETTINGS_QUEUE || 'settings_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // Statistics Service
      {
        name: 'STATISTICS_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.STATISTICS_QUEUE || 'statistics_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      // Beneficiary Service
      {
        name: 'BENEFICIARY_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: process.env.BENEFICIARY_QUEUE || 'beneficiary_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
    ]),

    // ==========================================
    // INTERNATIONALISATION
    // ==========================================
    I18nModule,
  ],

  // ==========================================
  // CONTROLLERS
  // ==========================================
  controllers: [ApiGatewayController],

  // ==========================================
  // PROVIDERS
  // ==========================================
  providers: [
    ApiGatewayService,
    JwtAuthGuard,
  ],

  // ==========================================
  // EXPORTS
  // ==========================================
  exports: [JwtModule, JwtAuthGuard],
})
export class ApiGatewayModule {}