// libs/common/src/db/shared-prisma.ts
import { PrismaClient } from '@prisma/client';

/**
 * Client Prisma partagé, créé à la demande (une seule instance par processus).
 *
 * Utilisé par le code qui n'a pas accès à l'injection Nest d'un PrismaService :
 *   - JwtAuthGuard (api-gateway) pour vérifier session / statut / maintenance
 *   - SmsService pour journaliser les SMS envoyés
 *
 * Pool de connexions volontairement réduit (SHARED_PRISMA_CONNECTION_LIMIT, défaut 3)
 * pour ne pas doubler la charge sur MySQL.
 */
let sharedClient: PrismaClient | null = null;

function buildDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (/[?&]connection_limit=/.test(url)) return url;
  const limit = process.env.SHARED_PRISMA_CONNECTION_LIMIT || '3';
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${limit}`;
}

export function getSharedPrisma(): PrismaClient {
  if (!sharedClient) {
    const url = buildDatabaseUrl();
    sharedClient = new PrismaClient({
      log: ['warn', 'error'],
      ...(url ? { datasources: { db: { url } } } : {}),
    });
  }
  return sharedClient;
}
