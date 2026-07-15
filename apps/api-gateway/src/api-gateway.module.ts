// api-gateway.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { I18nModule } from '@app/common'; // ✅ Importer I18nModule

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ClientsModule.register([
      {
        name: 'AUTH_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'auth_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'USER_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'user_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'TRANSACTION_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'transaction_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'NETBACKING_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'netbacking_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'MOBILE_BANKING_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'mobile_banking_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'NOTIFICATION_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'notification_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'AUDIT_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'audit_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'KYC_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'kyc_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'SETTINGS_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'settings_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'STATISTICS_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'statistics_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
      {
        name: 'BENEFICIARY_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'beneficiary_queue',
          queueOptions: {
            durable: true,
          },
          persistent: true,
          noAck: false,
          prefetchCount: 1,
        },
      },
    ]),
    I18nModule, // ✅ Ajouter I18nModule ici
  ],
  controllers: [ApiGatewayController],
  providers: [ApiGatewayService],
})
export class ApiGatewayModule {}