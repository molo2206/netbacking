// apps/wallet-service/src/prisma/prisma.module.ts
import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Module({
  providers: [PrismaService],
  exports: [PrismaService], // <- Très important pour que d'autres modules puissent l'utiliser
})
export class PrismaModule {}
