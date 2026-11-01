// main.ts - Auth Service
import { NestFactory } from '@nestjs/core';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { AuthServiceModule } from './auth-service.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
        queue: 'auth_queue',  // ← Doit correspondre à AUTH_QUEUE dans .env
        queueOptions: {
          durable: false,
        },
        persistent: true,
        noAck: true,
        prefetchCount: 1,
      },
    },
  );

  const logger = new Logger('AuthService');

  await app.listen();
  logger.log('🔐 Auth microservice is running with RabbitMQ');
  logger.log(`📨 Queue: auth_queue`);
  logger.log(`🔗 RabbitMQ URL: ${process.env.RABBITMQ_URL || 'amqp://localhost:5672'}`);
}
bootstrap();