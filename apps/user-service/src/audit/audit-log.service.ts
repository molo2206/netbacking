/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/audit/audit-log.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ═══════════════════════════════════════════════════════════════════
 * JOURNAL D'AUDIT (table audit_logs)
 * ═══════════════════════════════════════════════════════════════════
 * Répond aux routes admin/audit-* de l'API gateway :
 *   get_audit_logs, get_audit_log, get_user_audit_logs,
 *   get_audit_actions, get_audit_entities, get_audit_stats,
 *   delete_audit_log_by_id
 *
 * Dates : 'AAAA-MM-JJ' (heure de Lubumbashi, APP_TZ_OFFSET) ou ISO complet.
 * ═══════════════════════════════════════════════════════════════════
 */

const TZ_OFFSET = process.env.APP_TZ_OFFSET || '+02:00';
const LEVELS = ['INFO', 'WARN', 'ERROR'];

export interface AuditLogFilters {
  page?: number | string;
  limit?: number | string;
  userId?: string;
  action?: string;
  entity?: string;
  entityId?: string;
  level?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────── utilitaires ───────────────────────────

  private rpcError(message: string, statusCode: number) {
    return new RpcException({ status: 'error', message, statusCode });
  }

  private toInt(value: any, fallback: number, max = 200): number {
    const n = parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, max);
  }

  /** 'AAAA-MM-JJ' → début (ou lendemain si `endOfDay`) du jour à Lubumbashi ; ISO accepté. */
  private parseDate(value: string | undefined, endOfDay: boolean): Date | undefined {
    if (!value || !String(value).trim()) return undefined;
    const v = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(`${v}T00:00:00${TZ_OFFSET}`);
      if (endOfDay) d.setUTCDate(d.getUTCDate() + 1);
      return d;
    }
    const d = new Date(v);
    if (isNaN(d.getTime())) {
      throw this.rpcError(`Date invalide : ${v}. Utilisez le format AAAA-MM-JJ.`, 400);
    }
    return d;
  }

  private buildWhere(f: AuditLogFilters) {
    const where: any = {};
    if (f.userId) where.userId = String(f.userId).trim();
    if (f.action) {
      const actions = String(f.action).split(',').map((a) => a.trim()).filter(Boolean);
      where.action = actions.length > 1 ? { in: actions } : actions[0];
    }
    if (f.entity) {
      const entities = String(f.entity).split(',').map((e) => e.trim()).filter(Boolean);
      where.entity = entities.length > 1 ? { in: entities } : entities[0];
    }
    if (f.entityId) where.entityId = String(f.entityId).trim();
    if (f.level) {
      const level = String(f.level).toUpperCase();
      if (LEVELS.includes(level)) where.level = level;
    }

    const gte = this.parseDate(f.startDate, false);
    const lt = this.parseDate(f.endDate, true);
    if (gte && lt && gte >= lt) {
      throw this.rpcError('La date de début doit être antérieure à la date de fin.', 400);
    }
    if (gte || lt) where.createdAt = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };

    if (f.search && String(f.search).trim()) {
      const q = String(f.search).trim();
      where.OR = [
        { message: { contains: q } },
        { userName: { contains: q } },
        { action: { contains: q } },
        { entityId: { contains: q } },
        { ipAddress: { contains: q } },
      ];
    }
    return where;
  }

  private parseJson(value: string | null | undefined): any {
    if (value === null || value === undefined || value === '') return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private format(log: any) {
    const u = log.user;
    return {
      id: log.id,
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      level: log.level,
      userId: log.userId,
      userName:
        log.userName ||
        (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null) ||
        null,
      userRole: log.userRole || u?.role || null,
      user: u
        ? {
            id: u.id,
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
            phone: u.phone,
            clientId: u.clientId,
            role: u.role,
          }
        : null,
      details: this.parseJson(log.message),
      oldValue: this.parseJson(log.oldValue),
      newValue: this.parseJson(log.newValue),
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      createdAt: log.createdAt,
    };
  }

  private readonly userSelect = {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      clientId: true,
      role: true,
    },
  };

  // ─────────────────────────── liste ───────────────────────────

  async list(f: AuditLogFilters) {
    const page = this.toInt(f.page, 1, 100000);
    const limit = this.toInt(f.limit, 10, 200);
    const where = this.buildWhere(f);

    try {
      const [items, total] = await Promise.all([
        this.prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          include: { user: this.userSelect },
        }),
        this.prisma.auditLog.count({ where }),
      ]);

      return {
        message: "Journal d'audit récupéré avec succès",
        data: {
          data: items.map((l) => this.format(l)),
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPreviousPage: page > 1,
        },
      };
    } catch (err) {
      this.logger.error(`[list] ${err?.message || err}`);
      throw this.rpcError("Impossible de récupérer le journal d'audit", 500);
    }
  }

  async getById(id: string) {
    if (!id) throw this.rpcError('ID du log requis', 400);
    const log = await this.prisma.auditLog.findUnique({
      where: { id: String(id).trim() },
      include: { user: this.userSelect },
    });
    if (!log) throw this.rpcError("Entrée du journal d'audit introuvable", 404);
    return { message: "Entrée du journal d'audit récupérée", data: this.format(log) };
  }

  async listForUser(params: { userId: string; page?: number; limit?: number; startDate?: string; endDate?: string }) {
    if (!params.userId) throw this.rpcError('userId requis', 400);
    return this.list({ ...params });
  }

  // ─────────────────────────── listes de filtres ───────────────────────────

  async actions() {
    const rows = await this.prisma.auditLog.groupBy({
      by: ['action'],
      _count: { _all: true },
      orderBy: { action: 'asc' },
    });
    return {
      message: 'Actions récupérées',
      data: rows.map((r: any) => ({ action: r.action, count: r._count._all })),
    };
  }

  async entities() {
    const rows = await this.prisma.auditLog.groupBy({
      by: ['entity'],
      _count: { _all: true },
      orderBy: { entity: 'asc' },
    });
    return {
      message: 'Entités récupérées',
      data: rows.map((r: any) => ({ entity: r.entity, count: r._count._all })),
    };
  }

  // ─────────────────────────── statistiques ───────────────────────────

  async stats(params: { days?: number | string }) {
    const days = this.toInt(params.days, 7, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = { createdAt: { gte: since } };

    const [total, byLevel, byAction, byEntity, recentErrors, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({ by: ['level'], where, _count: { _all: true } }),
      this.prisma.auditLog.groupBy({
        by: ['action'],
        where,
        _count: { _all: true },
        orderBy: { _count: { action: 'desc' } },
        take: 15,
      }),
      this.prisma.auditLog.groupBy({
        by: ['entity'],
        where,
        _count: { _all: true },
        orderBy: { _count: { entity: 'desc' } },
        take: 15,
      }),
      this.prisma.auditLog.findMany({
        where: { ...where, level: 'ERROR' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { user: this.userSelect },
      }),
      this.prisma.auditLog.findMany({ where, select: { createdAt: true } }),
    ]);

    // Évolution par jour (heure de Lubumbashi)
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(TZ_OFFSET);
    const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : 120;
    const perDay: Record<string, number> = {};
    for (const r of rows) {
      if (!r.createdAt) continue;
      const day = new Date(r.createdAt.getTime() + offsetMin * 60000).toISOString().slice(0, 10);
      perDay[day] = (perDay[day] || 0) + 1;
    }

    const levelCount = (lvl: string) =>
      byLevel.find((b: any) => b.level === lvl)?._count?._all ?? 0;

    return {
      message: "Statistiques du journal d'audit",
      data: {
        days,
        since,
        total,
        byLevel: { INFO: levelCount('INFO'), WARN: levelCount('WARN'), ERROR: levelCount('ERROR') },
        topActions: byAction.map((r: any) => ({ action: r.action, count: r._count._all })),
        topEntities: byEntity.map((r: any) => ({ entity: r.entity, count: r._count._all })),
        byDay: Object.keys(perDay).sort().map((day) => ({ day, count: perDay[day] })),
        recentErrors: recentErrors.map((l) => this.format(l)),
      },
    };
  }

  // ─────────────────────────── suppression ───────────────────────────

  async deleteById(params: { id: string; adminId?: string }) {
    if (!params.id) throw this.rpcError('ID du log requis', 400);
    const existing = await this.prisma.auditLog.findUnique({ where: { id: String(params.id).trim() } });
    if (!existing) throw this.rpcError("Entrée du journal d'audit introuvable", 404);

    await this.prisma.auditLog.delete({ where: { id: existing.id } });

    // La suppression elle-même est tracée
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: params.adminId || undefined,
          action: 'AUDIT_LOG_DELETED',
          entity: 'AUDIT_LOG',
          entityId: existing.id,
          oldValue: JSON.stringify(this.format(existing)),
          level: 'WARN',
        },
      });
    } catch (err) {
      this.logger.warn(`[deleteById] trace de suppression impossible : ${err?.message || err}`);
    }

    return { message: "Entrée du journal d'audit supprimée", data: { id: existing.id } };
  }
}
