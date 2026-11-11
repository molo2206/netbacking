// libs/common/src/context/request-context.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { REQUEST_CONTEXT_FIELD, RequestContext, runWithRequestContext } from './request-context';

/**
 * Microservices (RabbitMQ) : retire le champ `__ctx` joint par l'API Gateway
 * et rend le contexte (IP, appareil, plateforme…) disponible pendant tout le
 * traitement du message. Le handler reçoit le message SANS `__ctx`.
 *
 * À enregistrer dans main.ts : app.useGlobalInterceptors(new RequestContextInterceptor())
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'rpc') return next.handle();

    const data = context.switchToRpc().getData();
    let ctx: Partial<RequestContext> = {};
    if (data && typeof data === 'object' && !Array.isArray(data) && REQUEST_CONTEXT_FIELD in data) {
      const raw = (data as any)[REQUEST_CONTEXT_FIELD];
      if (raw && typeof raw === 'object') ctx = { ...raw };
      delete (data as any)[REQUEST_CONTEXT_FIELD];
    }

    return new Observable((subscriber) => {
      const subscription = runWithRequestContext(ctx, () => next.handle().subscribe(subscriber));
      return () => subscription.unsubscribe();
    });
  }
}
