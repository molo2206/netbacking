// apps/transaction-service/src/main.ts
// ✅ Charge le .env AVANT tout le reste (les services lisent process.env dès leur construction)
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { TransactionServiceModule } from './transaction-service.module';
import { RequestContextInterceptor } from '../../../libs/common/src/context/request-context.interceptor';
import { ensureTrackingColumns } from '../../../libs/common/src/audit/write-audit';
import { getSharedPrisma } from '../../../libs/common/src/db/shared-prisma';

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

  // ✅ Contexte de la requête (IP, appareil, plateforme) transmis par l'API Gateway
  app.useGlobalInterceptors(new RequestContextInterceptor());
  // ✅ Colonnes de traçabilité (appareil / plateforme) présentes en base
  await ensureTrackingColumns(getSharedPrisma(), 'transaction-service');

  await app.listen();
  console.log('✅ Transaction Service is listening on RabbitMQ queue: transaction_queue');
}
bootstrap();