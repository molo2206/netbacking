import { NestFactory } from '@nestjs/core';
import { NetbackingServiceModule } from './netbacking-service.module';

async function bootstrap() {
  const app = await NestFactory.create(NetbackingServiceModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
