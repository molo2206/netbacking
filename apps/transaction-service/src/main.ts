// apps/transaction-service/src/main.ts
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { TransactionServiceModule } from './transaction-service.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    TransactionServiceModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'],
        queue: 'transaction_queue',
        queueOptions: { durable: false },
        noAck: true,
        persistent: true,
      },
    },
  );

  await app.listen();
  console.log('✅ Transaction Service is listening on RabbitMQ queue: transaction_queue');
}
bootstrap();