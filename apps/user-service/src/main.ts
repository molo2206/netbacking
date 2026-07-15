import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { UserServiceModule } from './user-service.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    UserServiceModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'],
        queue: 'user_queue',
        queueOptions: { durable: false },
        noAck: true, // 👈 TRÈS IMPORTANT
        persistent: true,
      },
    },
  );

  await app.listen();
  console.log('✅ User Service is listening on RabbitMQ queue: user_queue');
}
bootstrap();
