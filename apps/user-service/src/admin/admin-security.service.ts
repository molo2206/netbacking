/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/admin/admin-security.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { users_status } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { I18nService } from '../../../../libs/common/src/i18n/i18n.service';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { normalizePhoneToInternational } from '../../../../libs/common/src/utils/phone.util';
import { UserApprovalService } from '../approval/user-approval.service';

/**
 * ═══════════════════════════════════════════════════════════════════
 * ADMIN — SÉCURITÉ DES COMPTES UTILISATEURS
 * ═══════════════════════════════════════════════════════════════════
 *  - overview      : état de sécurité (PIN, verrouillages, sessions…)
 *  - unlockPin     : lève le blocage du PIN (3 erreurs)
 *  - resetPin      : supprime le PIN → l'utilisateur doit en créer un nouveau
 *  - block         : bloque le compte (SUSPENDED) + ferme toutes les sessions
 *  - unblock       : réactive le compte + lève les verrouillages
 *  - forceLogout   : ferme toutes les sessions (déconnexion sur tous les appareils)
 *  - resetPassword : nouveau mot de passe temporaire envoyé par SMS / email
 *
 * Règles :
 *  - un admin n'agit jamais sur son propre compte
 *  - seul un SUPER_ADMIN agit sur un ADMIN / SUPER_ADMIN
 *  - chaque action est tracée dans audit_logs (entity = USER_SECURITY)
 * ═══════════════════════════════════════════════════════════════════
 */

export interface AdminActionInput {
  userId: string;        // utilisateur ciblé
  adminId: string;       // admin qui agit
  reason?: string;
  notify?: boolean;      // envoyer un SMS à l'utilisateur (défaut : true)
  lang?: string;
  ipAddress?: string | null;
}

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];

@Injectable()
export class AdminSecurityService {
  private readonly logger = new Logger(AdminSecurityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18nService: I18nService,
    private readonly smsService: SmsService,
    private readonly approvalService: UserApprovalService,
  ) {}

  // ─────────────────────────── utilitaires ───────────────────────────

  private rpcError(message: string, statusCode: number): RpcException {
    return new RpcException({ status: 'error', message, statusCode });
  }

  /** Charge l'admin et la cible, et applique les règles d'autorisation. */
  private async loadActorAndTarget(input: AdminActionInput) {
    const lang = input.lang || 'fr';

    const [admin, target] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: input.adminId },
        select: { id: true, role: true, firstName: true, lastName: true },
      }),
      this.prisma.user.findUnique({ where: { id: input.userId } }),
    ]);

    if (!admin || !ADMIN_ROLES.includes(String(admin.role))) {
      throw this.rpcError(this.i18nService.translate('admin_only', lang), 403);
    }
    if (!target || target.deletedAt) {
      throw this.rpcError(this.i18nService.translate('user_not_found', lang), 404);
    }
    if (target.id === admin.id) {
      throw this.rpcError(this.i18nService.translate('admin_cannot_target_self', lang), 403);
    }
    if (ADMIN_ROLES.includes(String(target.role)) && admin.role !== 'SUPER_ADMIN') {
      throw this.rpcError(this.i18nService.translate('admin_super_admin_required', lang), 403);
    }

    return { admin, target, lang };
  }

  private async closeAllSessions(userId: string): Promise<number> {
    const res = await this.prisma.session.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, logoutAt: new Date() },
    });
    return res.count;
  }

  private async audit(
    admin: { id: string; role: any; firstName?: string | null; lastName?: string | null },
    action: string,
    targetId: string,
    details: any,
    ipAddress?: string | null,
    oldValue?: any,
    newValue?: any,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: admin.id,
          userName: `${admin.firstName || ''} ${admin.lastName || ''}`.trim() || null,
          userRole: String(admin.role || ''),
          action,
          entity: 'USER_SECURITY',
          entityId: targetId,
          message: details ? JSON.stringify(details) : null,
          oldValue: oldValue !== undefined ? JSON.stringify(oldValue) : undefined,
          newValue: newValue !== undefined ? JSON.stringify(newValue) : undefined,
          ipAddress: ipAddress || undefined,
          level: 'WARN',
        },
      });
    } catch (err) {
      this.logger.error(`Audit log failed: ${err?.message || err}`);
    }
  }

  private async notify(target: any, key: string, lang: string, params: Record<string, any> = {}) {
    const phone = normalizePhoneToInternational(target.phone);
    if (!phone) return false;
    try {
      return await this.smsService.sendSms(
        phone,
        this.i18nService.translate(key, lang, {
          firstName: target.firstName || '',
          lastName: target.lastName || '',
          ...params,
        }),
      );
    } catch (err) {
      this.logger.warn(`[notify] SMS ${key} échoué: ${err?.message || err}`);
      return false;
    }
  }

  private securitySnapshot(u: any) {
    return {
      status: u.status,
      pinStatus: u.pinStatus,
      failedPinAttempts: u.failedPinAttempts,
      pinLockedUntil: u.pinLockedUntil,
      failedLoginAttempts: u.failedLoginAttempts,
      lockedUntil: u.lockedUntil,
    };
  }

  // ─────────────────────────── lecture ───────────────────────────

  async overview(params: { userId: string; lang?: string }) {
    const lang = params.lang || 'fr';
    const user = await this.prisma.user.findUnique({ where: { id: params.userId } });
    if (!user || user.deletedAt) {
      throw this.rpcError(this.i18nService.translate('user_not_found', lang), 404);
    }

    const now = new Date();
    const [activeSessions, lastLogins, lastActions] = await Promise.all([
      this.prisma.session.findMany({
        where: { userId: user.id, isActive: true, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, deviceName: true, userAgent: true, ipAddress: true,
          os: true, browser: true, createdAt: true, expiresAt: true,
        },
      }),
      this.prisma.loginHistory
        .findMany({ where: { userId: user.id }, orderBy: { loginAt: 'desc' }, take: 10 })
        .catch(() => []),
      this.prisma.auditLog.findMany({
        where: { entity: 'USER_SECURITY', entityId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const pinLocked = !!(user.pinLockedUntil && user.pinLockedUntil > now);
    const loginLocked = !!(user.lockedUntil && user.lockedUntil > now);

    return {
      message: this.i18nService.translate('admin_security_overview', lang),
      data: {
        user: {
          id: user.id,
          clientId: user.clientId,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          email: user.email,
          role: user.role,
          status: user.status,
          lastLoginAt: user.lastLoginAt,
          lastLoginIp: user.lastLoginIp,
        },
        pin: {
          defined: !!user.pin,
          enabled: user.pinStatus === true,
          failedAttempts: user.failedPinAttempts || 0,
          lockedUntil: user.pinLockedUntil,
          locked: pinLocked,
        },
        login: {
          failedAttempts: user.failedLoginAttempts || 0,
          lockedUntil: user.lockedUntil,
          locked: loginLocked,
          mustChangePassword: user.mustChangePassword === true,
          tempPasswordExpiresAt: user.tempPasswordExpiresAt,
          isTwoFactorEnabled: user.isTwoFactorEnabled === true,
        },
        sessions: { activeCount: activeSessions.length, active: activeSessions },
        lastLogins,
        adminActions: lastActions,
      },
    };
  }

  // ─────────────────────────── actions ───────────────────────────

  async unlockPin(input: AdminActionInput) {
    const { admin, target, lang } = await this.loadActorAndTarget(input);
    const before = this.securitySnapshot(target);

    const updated = await this.prisma.user.update({
      where: { id: target.id },
      data: {
        failedPinAttempts: 0,
        pinLockedUntil: null,
        // Le statut LOCKED vient du blocage PIN : on le lève (sans toucher SUSPENDED)
        ...(target.status === users_status.LOCKED ? { status: users_status.ACTIVE } : {}),
      },
    });

    await this.audit(admin, 'ADMIN_UNLOCK_PIN', target.id, { reason: input.reason || null },
      input.ipAddress, before, this.securitySnapshot(updated));
    const smsSent = input.notify === false ? false : await this.notify(target, 'admin_pin_unlocked_sms', lang);

    return {
      message: this.i18nService.translate('admin_pin_unlocked', lang),
      data: { userId: target.id, ...this.securitySnapshot(updated), smsSent },
    };
  }

  async resetPin(input: AdminActionInput) {
    const { admin, target, lang } = await this.loadActorAndTarget(input);
    const before = this.securitySnapshot(target);

    const updated = await this.prisma.user.update({
      where: { id: target.id },
      data: {
        pin: null,
        pinStatus: false,
        failedPinAttempts: 0,
        pinLockedUntil: null,
        ...(target.status === users_status.LOCKED ? { status: users_status.ACTIVE } : {}),
      },
    });

    await this.audit(admin, 'ADMIN_RESET_PIN', target.id, { reason: input.reason || null },
      input.ipAddress, before, this.securitySnapshot(updated));
    const smsSent = input.notify === false ? false : await this.notify(target, 'admin_pin_reset_sms', lang);

    return {
      message: this.i18nService.translate('admin_pin_reset', lang),
      data: { userId: target.id, ...this.securitySnapshot(updated), smsSent },
    };
  }

  async block(input: AdminActionInput) {
    const { admin, target, lang } = await this.loadActorAndTarget(input);
    if (target.status === users_status.SUSPENDED) {
      throw this.rpcError(this.i18nService.translate('admin_user_already_blocked', lang), 409);
    }
    const before = this.securitySnapshot(target);

    const updated = await this.prisma.user.update({
      where: { id: target.id },
      data: { status: users_status.SUSPENDED },
    });
    const closedSessions = await this.closeAllSessions(target.id);

    await this.audit(admin, 'ADMIN_BLOCK_USER', target.id,
      { reason: input.reason || null, closedSessions }, input.ipAddress, before, this.securitySnapshot(updated));
    const smsSent = input.notify === false ? false : await this.notify(target, 'admin_account_blocked_sms', lang);

    return {
      message: this.i18nService.translate('admin_user_blocked', lang),
      data: { userId: target.id, status: updated.status, closedSessions, smsSent },
    };
  }

  async unblock(input: AdminActionInput) {
    const { admin, target, lang } = await this.loadActorAndTarget(input);
    const before = this.securitySnapshot(target);

    const updated = await this.prisma.user.update({
      where: { id: target.id },
      data: {
        status: users_status.ACTIVE,
        failedLoginAttempts: 0,
        lockedUntil: null,
        failedPinAttempts: 0,
        pinLockedUntil: null,
      },
    });

    await this.audit(admin, 'ADMIN_UNBLOCK_USER', target.id, { reason: input.reason || null },
      input.ipAddress, before, this.securitySnapshot(updated));
    const smsSent = input.notify === false ? false : await this.notify(target, 'admin_account_unblocked_sms', lang);

    return {
      message: this.i18nService.translate('admin_user_unblocked', lang),
      data: { userId: target.id, ...this.securitySnapshot(updated), smsSent },
    };
  }

  async forceLogout(input: AdminActionInput) {
    const { admin, target, lang } = await this.loadActorAndTarget(input);
    const closedSessions = await this.closeAllSessions(target.id);

    await this.audit(admin, 'ADMIN_FORCE_LOGOUT', target.id,
      { reason: input.reason || null, closedSessions }, input.ipAddress);

    return {
      message: this.i18nService.translate('admin_sessions_closed', lang, { count: closedSessions }),
      data: { userId: target.id, closedSessions },
    };
  }

  async resetPassword(input: AdminActionInput) {
    const { admin, target, lang } = await this.loadActorAndTarget(input);
    if (target.status !== users_status.ACTIVE && target.status !== users_status.LOCKED) {
      throw this.rpcError(this.i18nService.translate('admin_reset_password_not_allowed', lang), 409);
    }

    const result = await this.approvalService.adminResetPassword({
      id: target.id,
      adminId: admin.id,
      lang,
      ipAddress: input.ipAddress || undefined,
    });

    await this.audit(admin, 'ADMIN_RESET_PASSWORD', target.id,
      { reason: input.reason || null, delivery: result?.data?.delivery }, input.ipAddress);

    return result;
  }
}
