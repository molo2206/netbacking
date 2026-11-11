// ✅ Charge le .env AVANT tout le reste (les services lisent process.env dès leur construction)
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { UserServiceModule } from './user-service.module';
import { RequestContextInterceptor } from '../../../libs/common/src/context/request-context.interceptor';
import { ensureTrackingColumns } from '../../../libs/common/src/audit/write-audit';
import { getSharedPrisma } from '../../../libs/common/src/db/shared-prisma';

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

  // ✅ Contexte de la requête (IP, appareil, plateforme) transmis par l'API Gateway
  app.useGlobalInterceptors(new RequestContextInterceptor());
  // ✅ Colonnes de traçabilité (appareil / plateforme) présentes en base
  await ensureTrackingColumns(getSharedPrisma(), 'user-service');

  await app.listen();
  console.log('✅ User Service is listening on RabbitMQ queue: user_queue');
}
bootstrap();
