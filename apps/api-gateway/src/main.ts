// ✅ Charge le .env AVANT tout le reste (les services lisent process.env dès leur construction)
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module';
import { ActivityLogInterceptor } from './activity-log.interceptor';
import { buildRequestContext, runWithRequestContext } from '../../../libs/common/src/context/request-context';

/**
 * CORS : origines autorisées à appeler l'API depuis un navigateur (front web, admin).
 *   CORS_ORIGINS=https://admin.accesfinance.africa,http://localhost:5173
 *   CORS_ORIGINS=*   → toutes les origines (pratique en UAT, à éviter en production)
 * Toujours autorisés (même si CORS_ORIGINS est défini) :
 *   localhost (tous ports), *.accesfinance.africa,
 *   https://net-banking.vercel.app (front client) et https://net-admin-drab.vercel.app (admin)
 *   (+ leurs aperçus Vercel net-banking-xxx.vercel.app / net-admin-drab-xxx.vercel.app).
 */
function buildCorsOrigin(): (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void {
  const raw = (process.env.CORS_ORIGINS || '').trim();
  const list = raw.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const allowAll = list.includes('*');

  const defaults: RegExp[] = [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https:\/\/([a-z0-9-]+\.)*accesfinance\.africa$/,
    /^https:\/\/net-banking(-[a-z0-9-]+)?\.vercel\.app$/,
    /^https:\/\/net-admin-drab(-[a-z0-9-]+)?\.vercel\.app$/,
  ];

  return (origin, cb) => {
    // Requêtes sans origine : mobile, curl, Postman, serveur à serveur
    if (!origin) return cb(null, true);
    const o = origin.replace(/\/$/, '');
    if (allowAll) return cb(null, true);
    if (list.includes(o) || defaults.some((re) => re.test(o))) return cb(null, true);
    console.warn(`[CORS] Origine refusée : ${o}`);
    return cb(null, false);
  };
}

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);

  // ✅ Derrière Apache (reverse proxy local) : vraie IP du client via X-Forwarded-For.
  //    'loopback' : l'en-tête n'est cru que s'il vient du proxy local (pas falsifiable de l'extérieur)
  app.getHttpAdapter().getInstance().set('trust proxy', process.env.TRUST_PROXY || 'loopback');

  // ✅ Contexte de chaque requête : IP, appareil, navigateur, OS, plateforme
  //    → transmis aux microservices et ajouté aux audits / sessions / connexions
  app.use((req: any, _res: any, next: () => void) => {
    runWithRequestContext(buildRequestContext(req), next);
  });

  // ✅ Historique d'activité (activity_logs) : toutes les actions des utilisateurs connectés
  app.useGlobalInterceptors(new ActivityLogInterceptor());

  app.enableCors({
    origin: buildCorsOrigin(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'lang',
      'x-client',
      'x-platform',
      'x-device-id',
      'x-device-name',
      'x-device-model',
      'x-os',
      'x-os-version',
      'x-app-version',
      'X-Requested-With',
    ],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400,
  });

  const port = Number(process.env.PORT || process.env.port || 3000);
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);
  console.log(`🚀 API Gateway AccesFinance démarrée sur http://${host}:${port}`);
}
bootstrap();
