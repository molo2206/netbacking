// apps/auth-service/src/utility/guards/jwt-auth.guard.ts

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  checkSession,
  isSessionCheckEnabled,
} from '../../../../../libs/common/src/security/session-validator';
import { getRequestContext } from '../../../../../libs/common/src/context/request-context';

/**
 * Routes accessibles avec un mot de passe TEMPORAIRE (mustChangePassword=true).
 * Tout le reste de l'API est bloqué tant que l'utilisateur ne l'a pas changé.
 */
const ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED: RegExp[] = [
  /^\/(api\/)?(v\d+\/)?auth\/change-password\/?$/,
  /^\/(api\/)?(v\d+\/)?auth\/logout\/?$/,
  /^\/(api\/)?(v\d+\/)?auth\/profile\/?$/,
  /^\/(api\/)?(v\d+\/)?users\/me\/device-token\/?$/,
];

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    console.log('[JwtAuthGuard] Authorization header:', authHeader?.substring(0, 50) + '...');
    console.log('[JwtAuthGuard] URL:', request.url);

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[JwtAuthGuard] No token found');
      throw new UnauthorizedException('Token manquant');
    }

    const token = authHeader.split(' ')[1];
    console.log('[JwtAuthGuard] Token preview:', token.substring(0, 30) + '...');

    try {
      const secretKey = this.configService.get<string>('JWT_SECRET') || 'secret';
      
      const payload = this.jwtService.verify(token, {
        secret: secretKey,
      });

      const userId = payload.sub || payload.id;

      if (!userId) {
        console.log('[JwtAuthGuard] No user ID found in payload');
        throw new UnauthorizedException('Payload JWT invalide');
      }

      const user = {
        id: userId,
        email: payload.email ?? null,
        phone: payload.phone ?? null,
        full_name: payload.full_name ?? null,
        role: payload.role || 'USER',
        status: payload.status || 'ACTIVE',
        account_number: payload.account_number ?? null,
        deleted: payload.deleted ?? false,
        sessionToken: payload.sessionToken,
      };

      // ✅ Vérification en base : compte bloqué, session fermée, rôle à jour, maintenance
      if (isSessionCheckEnabled()) {
        let check;
        try {
          check = await checkSession(token, userId);
        } catch (dbErr) {
          // Base indisponible : on n'empêche pas l'accès (le JWT reste valide)
          console.error('[JwtAuthGuard] Vérification de session impossible:', dbErr?.message || dbErr);
          check = null;
        }
        if (check && !check.ok) {
          throw new HttpException(
            {
              status: 'error',
              code: check.code,
              message: check.message,
              statusCode: check.httpStatus,
            },
            check.httpStatus,
          );
        }
        if (check?.ok) {
          user.role = check.role;     // rôle à jour (changement appliqué sans reconnexion)
          user.status = check.status;
        }
      }

      request.currentUser = user;
      request.user = user;

      // ✅ Auteur de la requête : ajouté au contexte transmis aux microservices (audits)
      const ctx = getRequestContext();
      ctx.userId = user.id;
      ctx.userRole = user.role;

      // ✅ Mot de passe temporaire non encore changé → seules quelques routes sont permises
      if (payload.mustChangePassword === true) {
        const path = String(request.originalUrl || request.url || '').split('?')[0];
        const allowed = ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED.some((re) => re.test(path));
        if (!allowed) {
          throw new ForbiddenException({
            status: 'error',
            code: 'PASSWORD_CHANGE_REQUIRED',
            message: 'Vous devez remplacer votre mot de passe temporaire avant de continuer.',
            statusCode: 403,
          });
        }
      }

      console.log('[JwtAuthGuard] User attached:', {
        id: user.id,
        role: user.role,
        status: user.status,
      });

      return true;
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof HttpException) throw err;
      console.error('[JwtAuthGuard] Error:', err.message);

      // ✅ Token expiré → 401 Unauthorized
      if (err.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Token expiré');
      }
      
      // ✅ Token invalide → 401 Unauthorized
      if (err.name === 'JsonWebTokenError') {
        console.error('[JwtAuthGuard] JWT Error:', err.message);
        throw new UnauthorizedException('Token invalide');
      }
      
      throw new UnauthorizedException('Erreur d\'authentification');
    }
  }
}
