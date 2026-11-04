// ✅ Charge le .env AVANT tout le reste (les services lisent process.env dès leur construction)
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
