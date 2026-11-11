import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { NotificationModule } from './notification.module';
import * as dotenv from 'dotenv';
import { RequestContextInterceptor } from '../../../libs/common/src/context/request-context.interceptor';
import { ensureTrackingColumns } from '../../../libs/common/src/audit/write-audit';
import { getSharedPrisma } from '../../../libs/common/src/db/shared-prisma';

dotenv.config();

async function bootstrap() {
  const rabbitmqUrl =
    process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
  console.log('🔍 RABBITMQ_URL:', rabbitmqUrl);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    NotificationModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [rabbitmqUrl],
        queue: process.env.NOTIFICATION_QUEUE || 'notification_queue',
        queueOptions: { durable: false },
        noAck: true,
        persistent: true,
      },
    },
  );
  // ✅ Contexte de la requête (IP, appareil, plateforme) transmis par l'API Gateway
  app.useGlobalInterceptors(new RequestContextInterceptor());
  // ✅ Colonnes de traçabilité (appareil / plateforme) présentes en base
  await ensureTrackingColumns(getSharedPrisma(), 'notification-service');

  await app.listen();
  console.log('✅ Notification service is listening...');
}
bootstrap();
