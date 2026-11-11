// apps/api-gateway/src/activity-log.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { getSharedPrisma } from '../../../libs/common/src/db/shared-prisma';
import { enrichContextFromBody, getRequestContext } from '../../../libs/common/src/context/request-context';
import { currentPlatform } from '../../../libs/common/src/audit/write-audit';

/**
 * ═══════════════════════════════════════════════════════════════════
 * HISTORIQUE D'ACTIVITÉ (table activity_logs)
 * ═══════════════════════════════════════════════════════════════════
 * Chaque action d'un utilisateur connecté (POST / PUT / PATCH / DELETE,
 * + exports et relevés) est enregistrée : qui, quand, quelle route,
 * résultat, depuis quel appareil et quelle plateforme.
 * Le contenu des requêtes (mots de passe, OTP, PIN…) n'est JAMAIS enregistré.
 *
 * Désactivable : ACTIVITY_LOG_ENABLED=false
 * ═══════════════════════════════════════════════════════════════════
 */
const TRACKED_GET = /\/(export|statement|statements|csv|pdf)(\/|$)/i;

@Injectable()
export class ActivityLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('ActivityLog');
  private readonly enabled = String(process.env.ACTIVITY_LOG_ENABLED ?? 'true').toLowerCase() !== 'false';

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    // Body JSON disponible ici (après le parsing) : platform, deviceId, deviceName…
    enrichContextFromBody(getRequestContext(), req?.body);
    if (!this.enabled) return next.handle();
    const res = context.switchToHttp().getResponse();
    const method = String(req?.method || 'GET').toUpperCase();
    const path = String(req?.originalUrl || req?.url || '').split('?')[0];

    const tracked = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || (method === 'GET' && TRACKED_GET.test(path));
    if (!tracked) return next.handle();

    const started = Date.now();
    const ctx = getRequestContext();
    const write = (statusCode: number, error?: any) => {
      const user = req?.user || req?.currentUser;
      if (!user?.id) return; // non connecté (login, inscription…) : voir login_history / audit_logs
      void this.save(req, user, method, path, statusCode, Date.now() - started, ctx, error);
    };

    return next.handle().pipe(
      tap({
        next: () => write(res?.statusCode || 200),
        error: (err) => write(Number(err?.status || err?.getStatus?.() || 500), err),
      }),
    );
  }

  private async save(req: any, user: any, method: string, path: string, statusCode: number, durationMs: number, ctx: any, error?: any) {
    try {
      const route = req?.route?.path ? `/${String(req.route.path).replace(/^\//, '')}` : path;
      const segments = route.split('/').filter(Boolean);
      const activityType = (segments[0] === 'admin' && segments[1] ? `ADMIN_${segments[1]}` : segments[0] || 'API')
        .replace(/[^a-z0-9_]/gi, '_')
        .toUpperCase()
        .slice(0, 100);
      const success = statusCode < 400;
      const platform = await currentPlatform(ctx);

      await getSharedPrisma().activity_logs.create({
        data: {
          userId: String(user.id),
          userRole: user.role ? String(user.role) : null,
          activityType,
          activity: `${method} ${route}`.slice(0, 255),
          description: success
            ? `${method} ${path} → ${statusCode}`
            : `${method} ${path} → ${statusCode} : ${String(error?.response?.message || error?.message || 'échec').slice(0, 300)}`,
          ipAddress: ctx?.ipAddress || null,
          userAgent: ctx?.userAgent || null,
          metadata: JSON.stringify({
            method,
            route,
            path,
            params: req?.params && Object.keys(req.params).length ? req.params : undefined,
            statusCode,
            success,
            durationMs,
            platform,
            deviceType: ctx?.deviceType || null,
            deviceName: ctx?.deviceName || null,
            os: ctx?.os || null,
            browser: ctx?.browser || null,
            deviceId: ctx?.deviceId || null,
            appVersion: ctx?.appVersion || null,
            origin: ctx?.origin || null,
          }),
        },
      });
    } catch (err) {
      this.logger.warn(`Historique d'activité non enregistré : ${(err as any)?.message || err}`);
    }
  }
}
