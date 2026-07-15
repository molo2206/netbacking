import { NestFactory } from '@nestjs/core';
import { MobileBankingServiceModule } from './mobile-banking-service.module';

async function bootstrap() {
  const app = await NestFactory.create(MobileBankingServiceModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
