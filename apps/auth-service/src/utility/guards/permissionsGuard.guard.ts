/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// permissions.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { Permission, PERMISSION_METADATA } from './permissions.guard';

@Injectable()
export class PermissionsGuard implements CanActivate {
  private prisma: PrismaClient;

  constructor(private reflector: Reflector) {
    this.prisma = new PrismaClient();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.currentUser || request.user;

    if (!user) {
      throw new UnauthorizedException('Utilisateur non authentifié');
    }

    // Si l'utilisateur est SUPER_ADMIN, on bypass
    if (user.role === 'SUPER_ADMIN') {
      return true;
    }

    // Pour chaque permission requise, vérifier dans user_has_resources
    for (const perm of requiredPermissions) {
      await this.checkPermission(user.id, perm.resource, perm.action);
    }

    return true;
  }

  private async checkPermission(
    userId: string,
    resourceName: string,
    action: string,
  ): Promise<void> {
    try {
      // Récupérer la ressource par son nom
      const resource = await this.prisma.resources.findUnique({
        where: { name: resourceName },
      });

      if (!resource) {
        throw new ForbiddenException(`Ressource "${resourceName}" inexistante.`);
      }

      // Récupérer l'association user_has_resources avec les permissions
      const userResource = await this.prisma.user_has_resources.findUnique({
        where: {
          userId_resourceId: {
            userId,
            resourceId: resource.id,
          },
        },
      });

      if (!userResource) {
        throw new ForbiddenException(
          `Aucune permission pour la ressource "${resourceName}".`,
        );
      }

      // Vérifier si la permission est expirée
      if (userResource.expiresAt && userResource.expiresAt < new Date()) {
        throw new ForbiddenException(
          `La permission pour "${resourceName}" a expiré.`,
        );
      }

      // canManage donne tous les droits
      if (userResource.canManage) return;

      // ✅ Correction : Convertir les valeurs null en false
      let allowed = false;
      switch (action) {
        case 'canCreate':
          allowed = userResource.canCreate ?? false;
          break;
        case 'canRead':
          allowed = userResource.canRead ?? false;
          break;
        case 'canUpdate':
          allowed = userResource.canUpdate ?? false;
          break;
        case 'canDelete':
          allowed = userResource.canDelete ?? false;
          break;
        case 'canManage':
          allowed = userResource.canManage ?? false;
          break;
        default:
          throw new ForbiddenException(`Action "${action}" non reconnue.`);
      }

      if (!allowed) {
        throw new ForbiddenException(
          `Action "${action}" non autorisée sur la ressource "${resourceName}".`,
        );
      }
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      throw new ForbiddenException(
        `Erreur lors de la vérification des permissions: ${error.message}`,
      );
    }
  }
}