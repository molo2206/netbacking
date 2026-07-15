// src/auth/guards/authorize.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class AuthorizeGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedRoles = this.reflector.get<string[]>(
      'allowedRoles',
      context.getHandler(),
    );

    if (!allowedRoles || allowedRoles.length === 0) {
      return true; // Pas de rôles requis = accès autorisé
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const request = context.switchToHttp().getRequest();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const user = request.currentUser;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (!user || !user.role) {
      throw new UnauthorizedException(
        'Utilisateur non authentifié ou rôle manquant.',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
    if (!allowedRoles.includes(user.role)) {
      throw new UnauthorizedException(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        `Accès refusé pour le rôle : ${user.role}`,
      );
    }

    return true;
  }
}
