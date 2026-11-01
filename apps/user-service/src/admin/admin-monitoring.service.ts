/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/admin/admin-monitoring.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service';
import { I18nService } from '../../../../libs/common/src/i18n/i18n.service';

/**
 * ═══════════════════════════════════════════════════════════════════
 * ADMIN — SUPERVISION & RAPPORTS (données locales : audit_logs)
 * ═══════════════════════════════════════════════════════════════════
 *  - smsLogs          : journal des SMS (OTP, notifications) — contenus sensibles masqués
 *  - operationsReport : transferts / dépôts / retraits effectués via l'app
 *  - operationsCsv    : export CSV des mêmes opérations
 *
 * ℹ️ Les opérations proviennent des traces écrites par transaction-service après
 *    validation par la banque (actions TRANSFER, DEPOSIT, WITHDRAWAL). Les opérations
 *    faites en agence ou hors application n'y figurent pas.
 * ═══════════════════════════════════════════════════════════════════
 */

const OPERATION_ACTIONS = ['TRANSFER', 'DEPOSIT', 'WITHDRAWAL'];
const MAX_ROWS = parseInt(process.env.ADMIN_REPORT_MAX_ROWS || '50000', 10);
const TZ_OFFSET = process.env.APP_TZ_OFFSET || '+02:00'; // Africa/Lubumbashi

interface OperationRow {
  id: string;
  date: Date;
  day: string;
  action: string;
  userId: string | null;
  userName: string | null;
  amount: number;
  currency: string;
  fromAccount: string | null;
  toAccount: string | null;
  bankTransactionId: string | null;
  bankReference: string | null;
}

@Injectable()
export class AdminMonitoringService {
  private readonly logger = new Logger(AdminMonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18nService: I18nService,
  ) {}

  // ─────────────────────────── utilitaires ───────────────────────────

  private rpcError(message: string, statusCode: number) {
    return new RpcException({ status: 'error', message, statusCode });
  }

  /** Période 'yyyy-MM-dd' (heure de Lubumbashi). Défaut : 30 derniers jours. */
  private resolvePeriod(from?: string, to?: string, lang = 'fr') {
    const isDay = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if ((from && !isDay(from)) || (to && !isDay(to))) {
      throw this.rpcError(this.i18nService.translate('admin_invalid_period', lang), 400);
    }
    const today = this.localDay(new Date());
    const end = to || today;
    let start = from;
    if (!start) {
      const d = new Date(`${end}T00:00:00${TZ_OFFSET}`);
      d.setUTCDate(d.getUTCDate() - 29);
      start = this.localDay(d);
    }
    if (start > end) throw this.rpcError(this.i18nService.translate('admin_invalid_period', lang), 400);

    const gte = new Date(`${start}T00:00:00${TZ_OFFSET}`);
    const lt = new Date(`${end}T00:00:00${TZ_OFFSET}`);
    lt.setUTCDate(lt.getUTCDate() + 1);
    return { start, end, gte, lt };
  }

  /** Jour local 'yyyy-MM-dd' d'une date (décalage APP_TZ_OFFSET). */
  private localDay(date: Date): string {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(TZ_OFFSET);
    const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : 120;
    return new Date(date.getTime() + offsetMin * 60000).toISOString().slice(0, 10);
  }

  private parseJson(value: string | null): any {
    if (!value) return {};
    try { return JSON.parse(value); } catch { return {}; }
  }

  private async loadOperations(gte: Date, lt: Date, filters: { action?: string; userId?: string; currency?: string }) {
    const actions = filters.action && OPERATION_ACTIONS.includes(filters.action.toUpperCase())
      ? [filters.action.toUpperCase()]
      : OPERATION_ACTIONS;

    const logs = await this.prisma.auditLog.findMany({
      where: {
        action: { in: actions },
        createdAt: { gte, lt },
        ...(filters.userId ? { userId: filters.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: { user: { select: { firstName: true, lastName: true, clientId: true } } },
    });

    const rows: OperationRow[] = logs.map((l: any) => {
      const m = this.parseJson(l.message);
      const amount = Number(m.amount ?? 0);
      const date = l.createdAt || new Date();
      return {
        id: l.id,
        date,
        day: this.localDay(date),
        action: l.action,
        userId: l.userId,
        userName: l.user ? `${l.user.firstName || ''} ${l.user.lastName || ''}`.trim() : l.userName,
        amount: Number.isFinite(amount) ? amount : 0,
        currency: String(m.currency || 'USD').toUpperCase(),
        fromAccount: m.from ?? (l.action === 'WITHDRAWAL' ? m.accountNumber : null) ?? null,
        toAccount: m.to ?? (l.action === 'DEPOSIT' ? m.accountNumber : null) ?? null,
        bankTransactionId: m.bankTransactionId ?? m.bankData?.transactionId ?? l.entityId ?? null,
        bankReference: m.bankReference ?? m.bankData?.reference ?? null,
      };
    });

    return filters.currency
      ? rows.filter((r) => r.currency === filters.currency!.toUpperCase())
      : rows;
  }

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  // ─────────────────────────── journal SMS ───────────────────────────

  async smsLogs(params: {
    page?: number;
    limit?: number;
    status?: 'SENT' | 'FAILED';
    phone?: string;
    from?: string;
    to?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(params.limit) || 20));
    const { start, end, gte, lt } = this.resolvePeriod(params.from, params.to, lang);

    const where: any = {
      entity: 'SMS',
      createdAt: { gte, lt },
      ...(params.status === 'SENT' ? { action: 'SMS_SENT' } : {}),
      ...(params.status === 'FAILED' ? { action: 'SMS_FAILED' } : {}),
      ...(params.phone ? { entityId: { contains: String(params.phone).replace(/[^0-9]/g, '').slice(-6) } } : {}),
    };

    const [items, total, sent, failed] = await Promise.all([
      this.prisma.auditLog.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.count({ where: { entity: 'SMS', action: 'SMS_SENT', createdAt: { gte, lt } } }),
      this.prisma.auditLog.count({ where: { entity: 'SMS', action: 'SMS_FAILED', createdAt: { gte, lt } } }),
    ]);

    return {
      message: this.i18nService.translate('admin_sms_logs_retrieved', lang),
      data: {
        period: { from: start, to: end },
        summary: {
          sent,
          failed,
          successRate: sent + failed > 0 ? this.round((sent / (sent + failed)) * 100) : null,
        },
        data: items.map((i: any) => ({
          id: i.id,
          status: i.action === 'SMS_SENT' ? 'SENT' : 'FAILED',
          phone: i.entityId,
          ...this.parseJson(i.message),
          createdAt: i.createdAt,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─────────────────────────── rapport des opérations ───────────────────────────

  async operationsReport(params: {
    from?: string;
    to?: string;
    action?: string;
    currency?: string;
    userId?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    const { start, end, gte, lt } = this.resolvePeriod(params.from, params.to, lang);
    const rows = await this.loadOperations(gte, lt, params);

    // Totaux par opération et devise
    const totals: Record<string, Record<string, { count: number; amount: number }>> = {};
    // Évolution par jour
    const byDay: Record<string, Record<string, { count: number; amount: number }>> = {};
    // Utilisateurs les plus actifs (par devise)
    const byUser: Record<string, { userId: string; userName: string | null; currency: string; count: number; amount: number }> = {};

    for (const r of rows) {
      totals[r.action] ??= {};
      totals[r.action][r.currency] ??= { count: 0, amount: 0 };
      totals[r.action][r.currency].count += 1;
      totals[r.action][r.currency].amount += r.amount;

      const dayKey = `${r.action}:${r.currency}`;
      byDay[r.day] ??= {};
      byDay[r.day][dayKey] ??= { count: 0, amount: 0 };
      byDay[r.day][dayKey].count += 1;
      byDay[r.day][dayKey].amount += r.amount;

      if (r.userId) {
        const k = `${r.userId}:${r.currency}`;
        byUser[k] ??= { userId: r.userId, userName: r.userName, currency: r.currency, count: 0, amount: 0 };
        byUser[k].count += 1;
        byUser[k].amount += r.amount;
      }
    }

    for (const a of Object.values(totals)) for (const c of Object.values(a)) c.amount = this.round(c.amount);

    const days = Object.keys(byDay).sort().map((day) => ({
      day,
      operations: Object.entries(byDay[day]).map(([k, v]) => {
        const [action, currency] = k.split(':');
        return { action, currency, count: v.count, amount: this.round(v.amount) };
      }),
    }));

    const topUsers = Object.values(byUser)
      .map((u) => ({ ...u, amount: this.round(u.amount) }))
      .sort((a, b) => b.count - a.count || b.amount - a.amount)
      .slice(0, 10);

    return {
      message: this.i18nService.translate('admin_report_retrieved', lang),
      data: {
        period: { from: start, to: end },
        totalOperations: rows.length,
        truncated: rows.length >= MAX_ROWS,
        totals,
        byDay: days,
        topUsers,
        recent: rows.slice(0, 20),
      },
    };
  }

  async operationsCsv(params: {
    from?: string;
    to?: string;
    action?: string;
    currency?: string;
    userId?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    const { start, end, gte, lt } = this.resolvePeriod(params.from, params.to, lang);
    const rows = await this.loadOperations(gte, lt, params);

    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Date', 'Opération', 'Utilisateur', 'UserId', 'Montant', 'Devise',
      'Compte débité', 'Compte crédité', 'Transaction banque', 'Référence banque'];
    const lines = rows.map((r) => [
      r.date.toISOString(), r.action, r.userName, r.userId, r.amount.toFixed(2), r.currency,
      r.fromAccount, r.toAccount, r.bankTransactionId, r.bankReference,
    ].map(esc).join(';'));

    // BOM UTF-8 + séparateur « ; » → ouverture directe dans Excel (paramètres FR)
    const content = '﻿' + [header.join(';'), ...lines].join('\r\n');

    return {
      message: this.i18nService.translate('admin_report_retrieved', lang),
      data: {
        filename: `operations_${start}_${end}.csv`,
        contentType: 'text/csv; charset=utf-8',
        rows: rows.length,
        content,
      },
    };
  }
}
