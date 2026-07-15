import { NestFactory } from '@nestjs/core';
import { AuditServiceModule } from './audit-service.module';

async function bootstrap() {
  const app = await NestFactory.create(AuditServiceModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
