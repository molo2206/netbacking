/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/admin/operation-controls.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { I18nService } from '../../../../libs/common/src/i18n/i18n.service';
import {
  OPERATION_CONTROLS_KEY,
  OperationControls,
  invalidateOperationControlsCache,
  loadOperationControls,
  mergeOperationControls,
  validateOperationControls,
} from '../../../../libs/common/src/settings/operation-controls';

/**
 * Lecture / modification des contrôles d'opérations (table `settings`).
 *  - lecture : ADMIN et SUPER_ADMIN
 *  - modification : SUPER_ADMIN uniquement (paramètres sensibles)
 *  - version publique : pour les apps (maintenance, opérations ouvertes, plafonds)
 *
 * ⚠️ Les autres microservices gardent la valeur en cache 15 s
 *    (OPERATION_CONTROLS_CACHE_MS) : un changement s'applique en 15 s maximum.
 */
@Injectable()
export class OperationControlsService {
  private readonly logger = new Logger(OperationControlsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18nService: I18nService,
  ) {}

  private rpcError(message: string, statusCode: number) {
    return new RpcException({ status: 'error', message, statusCode });
  }

  async get(params: { lang?: string }) {
    const lang = params.lang || 'fr';
    const controls = await loadOperationControls(this.prisma, { fresh: true });
    return {
      message: this.i18nService.translate('admin_controls_retrieved', lang),
      data: controls,
    };
  }

  async getPublic(params: { lang?: string }) {
    const lang = params.lang || 'fr';
    const c = await loadOperationControls(this.prisma);
    return {
      message: this.i18nService.translate('admin_controls_retrieved', lang),
      data: {
        maintenanceMode: c.maintenanceMode,
        maintenanceMessage: c.maintenanceMode ? c.maintenanceMessage : null,
        transfersEnabled: c.transfersEnabled,
        depositsEnabled: c.depositsEnabled,
        withdrawalsEnabled: c.withdrawalsEnabled,
        limits: c.limits,
      },
    };
  }

  async update(params: {
    adminId: string;
    patch: Partial<OperationControls>;
    lang?: string;
    ipAddress?: string | null;
  }) {
    const lang = params.lang || 'fr';

    const admin = await this.prisma.user.findUnique({
      where: { id: params.adminId },
      select: { id: true, role: true, firstName: true, lastName: true },
    });
    if (!admin || admin.role !== 'SUPER_ADMIN') {
      throw this.rpcError(this.i18nService.translate('admin_super_admin_required', lang), 403);
    }

    const current = await loadOperationControls(this.prisma, { fresh: true });
    const next = mergeOperationControls(current, {
      ...(params.patch || {}),
      updatedAt: new Date().toISOString(),
      updatedBy: admin.id,
    });

    const errors = validateOperationControls(next);
    if (errors.length) {
      throw this.rpcError(
        this.i18nService.translate('admin_controls_invalid', lang, { errors: errors.join(' ; ') }),
        400,
      );
    }

    await this.prisma.settings.upsert({
      where: { key: OPERATION_CONTROLS_KEY },
      update: { value: JSON.stringify(next), updatedBy: admin.id, updatedAt: new Date() },
      create: {
        id: crypto.randomUUID(),
        key: OPERATION_CONTROLS_KEY,
        value: JSON.stringify(next),
        category: 'operations',
        description: 'Contrôle des opérations (maintenance, activation, plafonds)',
        isPublic: false,
        updatedBy: admin.id,
      },
    });
    invalidateOperationControlsCache();

    try {
      await this.prisma.auditLog.create({
        data: {
          userId: admin.id,
          userName: `${admin.firstName || ''} ${admin.lastName || ''}`.trim() || null,
          userRole: String(admin.role),
          action: 'ADMIN_UPDATE_OPERATION_CONTROLS',
          entity: 'SETTINGS',
          entityId: null,
          oldValue: JSON.stringify(current),
          newValue: JSON.stringify(next),
          ipAddress: params.ipAddress || undefined,
          level: 'WARN',
        },
      });
    } catch (err) {
      this.logger.error(`Audit log failed: ${err?.message || err}`);
    }

    return {
      message: this.i18nService.translate('admin_controls_updated', lang),
      data: next,
    };
  }
}
