/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/admin/admin-stats.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service';
import { I18nService } from '../../../../libs/common/src/i18n/i18n.service';
import { normalizePlatform, CHANNEL_LABELS, AppPlatform } from '../../../../libs/common/src/utils/platform.util';
import { MailService } from 'apps/auth-service/src/email/email.service';

/**
 * ═══════════════════════════════════════════════════════════════════
 * ADMIN — STATISTIQUES
 * ═══════════════════════════════════════════════════════════════════
 *  1. Utilisateurs MOBILE / WEB (inscription, connexions, en ligne)
 *  2. Volumes de transactions (filtres : période, type, devise, plateforme,
 *     statut, utilisateur, compte, montant min/max, recherche, regroupement)
 *  3. Liste paginée + export CSV des transactions
 *  4. État de l'envoi d'emails + email de test
 *  5. Rapports séparés MOBILE BANKING / NET BANKING : opérations + comptes créés
 *
 * Source des transactions : opérations faites via l'application et validées
 * par la banque (audit_logs : TRANSFER, DEPOSIT, WITHDRAWAL). Les opérations
 * faites en agence n'y figurent pas.
 * ═══════════════════════════════════════════════════════════════════
 */

const OPERATION_TYPES = ['TRANSFER', 'DEPOSIT', 'WITHDRAWAL'];
const MAX_ROWS = parseInt(process.env.ADMIN_REPORT_MAX_ROWS || '50000', 10);
const TZ_OFFSET = process.env.APP_TZ_OFFSET || '+02:00';

export interface TransactionFilters {
  from?: string;
  to?: string;
  type?: string;          // TRANSFER | DEPOSIT | WITHDRAWAL (ou liste séparée par des virgules)
  currency?: string;      // USD | CDF
  platform?: string;      // MOBILE | WEB
  status?: string;        // SUCCESS | …
  userId?: string;
  accountNumber?: string; // compte débité ou crédité
  minAmount?: number | string;
  maxAmount?: number | string;
  search?: string;        // référence, id banque, nom, compte, code client
  groupBy?: 'day' | 'week' | 'month';
  page?: number;
  limit?: number;
  sort?: 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
  lang?: string;
}

interface OperationRow {
  id: string;
  date: Date;
  day: string;
  type: string;
  status: string;
  platform: 'MOBILE' | 'WEB' | 'UNKNOWN' | string;
  userId: string | null;
  userName: string | null;
  clientId: string | null;
  amount: number;
  fees: number;
  currency: string;
  fromAccount: string | null;
  toAccount: string | null;
  receiverName: string | null;
  bankTransactionId: string | null;
  bankReference: string | null;
}

@Injectable()
export class AdminStatsService {
  private readonly logger = new Logger(AdminStatsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18nService: I18nService,
    private readonly mailService: MailService,
  ) {}

  // ─────────────────────────── utilitaires ───────────────────────────

  private rpcError(message: string, statusCode: number) {
    return new RpcException({ status: 'error', message, statusCode });
  }

  private offsetMinutes(): number {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(TZ_OFFSET);
    return m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : 120;
  }

  private localDay(date: Date): string {
    return new Date(date.getTime() + this.offsetMinutes() * 60000).toISOString().slice(0, 10);
  }

  /** Période 'yyyy-MM-dd' (heure de Lubumbashi). Défaut : 30 derniers jours. */
  private resolvePeriod(from?: string, to?: string, lang = 'fr', defaultDays = 30) {
    const isDay = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if ((from && !isDay(from)) || (to && !isDay(to))) {
      throw this.rpcError(this.i18nService.translate('admin_invalid_period', lang), 400);
    }
    const end = to || this.localDay(new Date());
    let start = from;
    if (!start) {
      const d = new Date(`${end}T00:00:00${TZ_OFFSET}`);
      d.setUTCDate(d.getUTCDate() - (defaultDays - 1));
      start = this.localDay(d);
    }
    if (start > end) throw this.rpcError(this.i18nService.translate('admin_invalid_period', lang), 400);
    const gte = new Date(`${start}T00:00:00${TZ_OFFSET}`);
    const lt = new Date(`${end}T00:00:00${TZ_OFFSET}`);
    lt.setUTCDate(lt.getUTCDate() + 1);
    return { start, end, gte, lt };
  }

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  private bucket(day: string, groupBy?: string): string {
    if (groupBy === 'month') return day.slice(0, 7);
    if (groupBy === 'week') {
      const d = new Date(`${day}T00:00:00Z`);
      const dow = (d.getUTCDay() + 6) % 7; // lundi = 0
      d.setUTCDate(d.getUTCDate() - dow);
      return `semaine du ${d.toISOString().slice(0, 10)}`;
    }
    return day;
  }

  private parseJson(value: string | null): any {
    if (!value) return {};
    try { return JSON.parse(value); } catch { return {}; }
  }

  private platformLabel(raw: any, fallback?: any): string {
    const p = normalizePlatform(raw);
    if (p !== 'UNKNOWN') return p;
    const f = normalizePlatform(fallback);
    return f === 'UNKNOWN' ? 'UNKNOWN' : f;
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. UTILISATEURS MOBILE / WEB
  // ═══════════════════════════════════════════════════════════════

  async usersByPlatform(params: { from?: string; to?: string; lang?: string }) {
    const lang = params.lang || 'fr';
    const { start, end, gte, lt } = this.resolvePeriod(params.from, params.to, lang);

    // Inscriptions (clients de l'application)
    const users = await this.prisma.user.findMany({
      where: { role: 'USER', deletedAt: null },
      select: { platform: true, status: true, createdAt: true },
    });

    const empty = () => ({ MOBILE: 0, WEB: 0, BACK_OFFICE: 0, UNKNOWN: 0, total: 0 });
    const registered = empty();
    const byStatus: Record<string, ReturnType<typeof empty>> = {};
    const newInPeriod = empty();
    const newByDay: Record<string, ReturnType<typeof empty>> = {};

    for (const u of users) {
      const p = this.platformLabel(u.platform) as AppPlatform;
      registered[p] += 1;
      registered.total += 1;
      const st = String(u.status || 'UNKNOWN');
      byStatus[st] ??= empty();
      byStatus[st][p] += 1;
      byStatus[st].total += 1;
      if (u.createdAt && u.createdAt >= gte && u.createdAt < lt) {
        newInPeriod[p] += 1;
        newInPeriod.total += 1;
        const day = this.localDay(u.createdAt);
        newByDay[day] ??= empty();
        newByDay[day][p] += 1;
        newByDay[day].total += 1;
      }
    }

    // Connexions sur la période (colonne platform : migration 20261104)
    let activeInPeriod: any = null;
    let loginsInPeriod: any = null;
    let onlineNow: any = null;
    let trackingEnabled = true;
    try {
      const active: any[] = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(lh.platform, 'UNKNOWN') AS platform,
                COUNT(DISTINCT lh.userId) AS users,
                COUNT(*) AS logins
           FROM login_history lh
           JOIN users u ON u.id = lh.userId
          WHERE lh.success = 1 AND lh.loginAt >= ? AND lh.loginAt < ? AND u.role = 'USER'
          GROUP BY COALESCE(lh.platform, 'UNKNOWN')`,
        gte,
        lt,
      );
      activeInPeriod = empty();
      loginsInPeriod = empty();
      for (const r of active) {
        const p = this.platformLabel(r.platform) as AppPlatform;
        activeInPeriod[p] += Number(r.users);
        loginsInPeriod[p] += Number(r.logins);
      }
      const distinct: any[] = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT COUNT(DISTINCT lh.userId) AS n FROM login_history lh JOIN users u ON u.id = lh.userId
          WHERE lh.success = 1 AND lh.loginAt >= ? AND lh.loginAt < ? AND u.role = 'USER'`,
        gte,
        lt,
      );
      activeInPeriod.total = Number(distinct?.[0]?.n || 0);
      loginsInPeriod.total = loginsInPeriod.MOBILE + loginsInPeriod.WEB + loginsInPeriod.BACK_OFFICE + loginsInPeriod.UNKNOWN;

      const online: any[] = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(s.platform, 'UNKNOWN') AS platform, COUNT(DISTINCT s.userId) AS users
           FROM sessions s JOIN users u ON u.id = s.userId
          WHERE s.isActive = 1 AND s.expiresAt > NOW() AND u.role = 'USER'
          GROUP BY COALESCE(s.platform, 'UNKNOWN')`,
      );
      onlineNow = empty();
      for (const r of online) {
        const p = this.platformLabel(r.platform) as AppPlatform;
        onlineNow[p] += Number(r.users);
        onlineNow.total += Number(r.users);
      }
    } catch (err) {
      trackingEnabled = false;
      this.logger.warn(`[usersByPlatform] colonne platform absente (migration 20261104) : ${err?.message || err}`);
    }

    // Appareils mobiles prêts à recevoir des notifications
    const pushDevices = await this.prisma.device.count({
      where: { pushToken: { not: null }, OR: [{ isActive: true }, { isActive: null }] },
    });

    return {
      message: this.i18nService.translate('admin_stats_retrieved', lang),
      data: {
        period: { from: start, to: end },
        registered,
        byStatus,
        newInPeriod,
        newByDay: Object.keys(newByDay).sort().map((day) => ({ day, ...newByDay[day] })),
        activeInPeriod,
        loginsInPeriod,
        onlineNow,
        pushDevices,
        platformTracking: trackingEnabled
          ? 'OK'
          : 'Migration prisma/sql/20261104_platform_tracking.sql à appliquer pour les connexions par plateforme',
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. TRANSACTIONS : chargement + filtres
  // ═══════════════════════════════════════════════════════════════

  private async loadOperations(f: TransactionFilters) {
    const lang = f.lang || 'fr';
    const period = this.resolvePeriod(f.from, f.to, lang);

    const types = f.type
      ? String(f.type).toUpperCase().split(',').map((t) => (t.trim() === 'WITHDRAW' ? 'WITHDRAWAL' : t.trim()))
          .filter((t) => OPERATION_TYPES.includes(t))
      : OPERATION_TYPES;

    const logs = await this.prisma.auditLog.findMany({
      where: {
        action: { in: types.length ? types : OPERATION_TYPES },
        createdAt: { gte: period.gte, lt: period.lt },
        ...(f.userId ? { userId: f.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: {
        user: { select: { firstName: true, lastName: true, clientId: true, platform: true } },
      },
    });

    let rows: OperationRow[] = logs.map((l: any) => {
      const m = this.parseJson(l.message);
      const amount = Number(m.amount ?? 0);
      const date = l.createdAt || new Date();
      return {
        id: l.id,
        date,
        day: this.localDay(date),
        type: l.action,
        status: String(m.status || m.bankData?.status || 'SUCCESS').toUpperCase(),
        // Canal enregistré par l'API Gateway (channel), sinon plateforme bancaire, sinon
        // plateforme d'inscription du client (opérations antérieures au suivi du canal)
        platform: this.platformLabel(m.channel, m.platform ?? l.user?.platform),
        userId: l.userId,
        userName: l.user ? `${l.user.firstName || ''} ${l.user.lastName || ''}`.trim() : l.userName,
        clientId: l.user?.clientId ?? null,
        amount: Number.isFinite(amount) ? amount : 0,
        fees: Number(m.fees ?? m.bankData?.fees ?? 0) || 0,
        currency: String(m.currency || 'USD').toUpperCase(),
        fromAccount: m.from ?? (l.action === 'WITHDRAWAL' ? m.accountNumber : null) ?? null,
        toAccount: m.to ?? (l.action === 'DEPOSIT' ? m.accountNumber : null) ?? null,
        receiverName: m.receiverName ?? null,
        bankTransactionId: m.bankTransactionId ?? m.bankData?.transactionId ?? l.entityId ?? null,
        bankReference: m.bankReference ?? m.bankData?.reference ?? null,
      };
    });

    // Filtres complémentaires
    if (f.currency) rows = rows.filter((r) => r.currency === String(f.currency).toUpperCase());
    if (f.platform) {
      const wanted = normalizePlatform(f.platform);
      rows = rows.filter((r) => r.platform === wanted);
    }
    if (f.status) rows = rows.filter((r) => r.status === String(f.status).toUpperCase());
    if (f.accountNumber) {
      const acc = String(f.accountNumber).trim();
      rows = rows.filter((r) => r.fromAccount === acc || r.toAccount === acc);
    }
    const min = f.minAmount !== undefined && f.minAmount !== '' ? Number(f.minAmount) : null;
    const max = f.maxAmount !== undefined && f.maxAmount !== '' ? Number(f.maxAmount) : null;
    if (min !== null && Number.isFinite(min)) rows = rows.filter((r) => r.amount >= min);
    if (max !== null && Number.isFinite(max)) rows = rows.filter((r) => r.amount <= max);
    if (f.search) {
      const q = String(f.search).toLowerCase().trim();
      rows = rows.filter((r) =>
        [r.bankReference, r.bankTransactionId, r.userName, r.clientId, r.fromAccount, r.toAccount, r.receiverName]
          .some((v) => v && String(v).toLowerCase().includes(q)),
      );
    }

    switch (f.sort) {
      case 'date_asc': rows.sort((a, b) => a.date.getTime() - b.date.getTime()); break;
      case 'amount_desc': rows.sort((a, b) => b.amount - a.amount); break;
      case 'amount_asc': rows.sort((a, b) => a.amount - b.amount); break;
      default: break; // déjà du plus récent au plus ancien
    }

    return { period, rows, truncated: logs.length >= MAX_ROWS };
  }

  private summarize(rows: OperationRow[], groupBy?: string) {
    const acc = () => ({ count: 0, amount: 0, fees: 0, max: 0 });
    type Acc = ReturnType<typeof acc>;
    const byCurrency: Record<string, Acc> = {};
    const byType: Record<string, Record<string, Acc>> = {};
    const byPlatform: Record<string, Record<string, Acc>> = {};
    const byPeriod: Record<string, Record<string, Acc>> = {};
    const byUser: Record<string, { userId: string; userName: string | null; clientId: string | null; currency: string; count: number; amount: number }> = {};

    const add = (a: Acc, r: OperationRow) => {
      a.count += 1;
      a.amount += r.amount;
      a.fees += r.fees;
      if (r.amount > a.max) a.max = r.amount;
    };

    for (const r of rows) {
      add((byCurrency[r.currency] ??= acc()), r);
      add(((byType[r.type] ??= {})[r.currency] ??= acc()), r);
      add(((byPlatform[r.platform] ??= {})[r.currency] ??= acc()), r);
      add(((byPeriod[this.bucket(r.day, groupBy)] ??= {})[`${r.type}:${r.currency}`] ??= acc()), r);
      if (r.userId) {
        const k = `${r.userId}:${r.currency}`;
        byUser[k] ??= { userId: r.userId, userName: r.userName, clientId: r.clientId, currency: r.currency, count: 0, amount: 0 };
        byUser[k].count += 1;
        byUser[k].amount += r.amount;
      }
    }

    const fmt = (a: Acc) => ({
      count: a.count,
      amount: this.round(a.amount),
      fees: this.round(a.fees),
      average: a.count ? this.round(a.amount / a.count) : 0,
      max: this.round(a.max),
    });
    const mapNested = (o: Record<string, Record<string, Acc>>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([c, a]) => [c, fmt(a)]))]));

    return {
      totalOperations: rows.length,
      byCurrency: Object.fromEntries(Object.entries(byCurrency).map(([c, a]) => [c, fmt(a)])),
      byType: mapNested(byType),
      byPlatform: mapNested(byPlatform),
      timeline: Object.keys(byPeriod).sort().map((period) => ({
        period,
        operations: Object.entries(byPeriod[period]).map(([k, a]) => {
          const [type, currency] = k.split(':');
          return { type, currency, ...fmt(a) };
        }),
      })),
      topUsers: Object.values(byUser)
        .map((u) => ({ ...u, amount: this.round(u.amount) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10),
    };
  }

  private publicRow(r: OperationRow) {
    return {
      id: r.id,
      date: r.date,
      type: r.type,
      status: r.status,
      platform: r.platform,
      amount: r.amount,
      fees: r.fees,
      currency: r.currency,
      fromAccount: r.fromAccount,
      toAccount: r.toAccount,
      receiverName: r.receiverName,
      userId: r.userId,
      userName: r.userName,
      clientId: r.clientId,
      bankTransactionId: r.bankTransactionId,
      bankReference: r.bankReference,
    };
  }

  /** Volumes (totaux, par type, par plateforme, évolution, top utilisateurs). */
  async transactionVolumes(f: TransactionFilters) {
    const lang = f.lang || 'fr';
    const { period, rows, truncated } = await this.loadOperations(f);
    return {
      message: this.i18nService.translate('admin_stats_retrieved', lang),
      data: {
        period: { from: period.start, to: period.end },
        filters: this.cleanFilters(f),
        truncated,
        ...this.summarize(rows, f.groupBy),
      },
    };
  }

  /** Liste paginée des transactions + résumé des volumes sur les mêmes filtres. */
  async listTransactions(f: TransactionFilters) {
    const lang = f.lang || 'fr';
    const page = Math.max(1, Number(f.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 20));
    const { period, rows, truncated } = await this.loadOperations(f);
    const summary = this.summarize(rows, f.groupBy);

    return {
      message: this.i18nService.translate('transactions_list_success', lang),
      data: {
        period: { from: period.start, to: period.end },
        filters: this.cleanFilters(f),
        summary: {
          totalOperations: summary.totalOperations,
          byCurrency: summary.byCurrency,
          byType: summary.byType,
          byPlatform: summary.byPlatform,
        },
        data: rows.slice((page - 1) * limit, page * limit).map((r) => this.publicRow(r)),
        total: rows.length,
        page,
        limit,
        totalPages: Math.ceil(rows.length / limit),
        hasNextPage: page * limit < rows.length,
        hasPreviousPage: page > 1,
        truncated,
      },
    };
  }

  async transactionsCsv(f: TransactionFilters) {
    const lang = f.lang || 'fr';
    const { period, rows } = await this.loadOperations(f);
    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Date', 'Type', 'Statut', 'Plateforme', 'Montant', 'Frais', 'Devise', 'Compte débité',
      'Compte crédité', 'Bénéficiaire', 'Client', 'Code client', 'Transaction banque', 'Référence banque'];
    const lines = rows.map((r) => [
      r.date.toISOString(), r.type, r.status, r.platform, r.amount.toFixed(2), r.fees.toFixed(2), r.currency,
      r.fromAccount, r.toAccount, r.receiverName, r.userName, r.clientId, r.bankTransactionId, r.bankReference,
    ].map(esc).join(';'));

    return {
      message: this.i18nService.translate('admin_report_retrieved', lang),
      data: {
        filename: `transactions_${period.start}_${period.end}.csv`,
        contentType: 'text/csv; charset=utf-8',
        rows: rows.length,
        content: '﻿' + [header.join(';'), ...lines].join('\r\n'),
      },
    };
  }

  private cleanFilters(f: TransactionFilters) {
    const out: Record<string, any> = {};
    for (const k of ['type', 'currency', 'platform', 'status', 'userId', 'accountNumber', 'minAmount', 'maxAmount', 'search', 'groupBy', 'sort']) {
      const v = (f as any)[k];
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. RAPPORTS PAR CANAL : MOBILE BANKING / NET BANKING
  // ═══════════════════════════════════════════════════════════════

  /** « mobile », « mobile-banking », « net », « net-banking », « web »… → MOBILE / WEB. */
  private parseChannel(raw: any, lang = 'fr'): AppPlatform {
    const v = String(raw || '').trim().toUpperCase();
    if (!v) throw this.rpcError(this.channelError(lang), 400);
    if (/^NET|^WEB|ONLINE|INTERNET/.test(v)) return 'WEB';
    const p = normalizePlatform(v);
    if (p === 'UNKNOWN' && v !== 'UNKNOWN') throw this.rpcError(this.channelError(lang), 400);
    return p;
  }

  private channelError(lang: string) {
    return lang === 'en'
      ? 'Invalid channel. Accepted values: MOBILE (Mobile Banking), WEB (Net Banking), BACK_OFFICE, UNKNOWN.'
      : 'Canal invalide. Valeurs acceptées : MOBILE (Mobile Banking), WEB (Net Banking), BACK_OFFICE, UNKNOWN.';
  }

  /** Comptes clients (rôle USER) créés sur la période, avec leur canal d'inscription. */
  private async loadAccounts(params: { from?: string; to?: string; channel?: string; status?: string; search?: string; lang?: string }) {
    const lang = params.lang || 'fr';
    const period = this.resolvePeriod(params.from, params.to, lang);
    const users = await this.prisma.user.findMany({
      where: {
        role: 'USER',
        deletedAt: null,
        createdAt: { gte: period.gte, lt: period.lt },
        ...(params.status ? { status: String(params.status).toUpperCase() as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      select: {
        id: true, clientId: true, firstName: true, lastName: true, phone: true, email: true,
        status: true, platform: true, createdAt: true, approvedAt: true, lastLoginAt: true,
      },
    });

    let rows = users.map((u) => {
      const channel = this.platformLabel(u.platform) as AppPlatform;
      return {
        id: u.id,
        clientId: u.clientId,
        name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
        phone: u.phone,
        email: u.email,
        status: String(u.status || 'UNKNOWN'),
        channel,
        channelLabel: CHANNEL_LABELS[channel],
        createdAt: u.createdAt,
        approvedAt: u.approvedAt,
        lastLoginAt: u.lastLoginAt,
      };
    });

    if (params.channel) {
      const wanted = this.parseChannel(params.channel, lang);
      rows = rows.filter((r) => r.channel === wanted);
    }
    if (params.search) {
      const q = String(params.search).toLowerCase().trim();
      rows = rows.filter((r) =>
        [r.clientId, r.name, r.phone, r.email].some((v) => v && String(v).toLowerCase().includes(q)),
      );
    }
    return { period, rows };
  }

  private accountsSummary(rows: Array<{ channel: string; status: string; createdAt: Date | null }>) {
    const byStatus: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (r.createdAt) {
        const d = this.localDay(r.createdAt);
        byDay[d] = (byDay[d] || 0) + 1;
      }
    }
    return {
      created: rows.length,
      approved: byStatus['ACTIVE'] || 0,
      pending: byStatus['PENDING_VERIFICATION'] || 0,
      rejected: byStatus['REJECTED'] || 0,
      byStatus,
      byDay: Object.keys(byDay).sort().map((day) => ({ day, count: byDay[day] })),
    };
  }

  /** Utilisateurs connectés sur la période via ce canal (login_history.platform). */
  private async activeUsersOnChannel(channel: AppPlatform, gte: Date, lt: Date): Promise<{ users: number; logins: number } | null> {
    try {
      const rows: any[] = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT COUNT(DISTINCT lh.userId) AS users, COUNT(*) AS logins
           FROM login_history lh JOIN users u ON u.id = lh.userId
          WHERE lh.success = 1 AND lh.loginAt >= ? AND lh.loginAt < ? AND u.role = 'USER'
            AND COALESCE(lh.platform, 'UNKNOWN') = ?`,
        gte, lt, channel,
      );
      return { users: Number(rows?.[0]?.users || 0), logins: Number(rows?.[0]?.logins || 0) };
    } catch {
      return null; // migration 20261104 non appliquée
    }
  }

  /**
   * Rapport d'UN canal : MOBILE = Mobile Banking, WEB = Net Banking.
   * Opérations (résumé + liste paginée) + comptes créés + utilisateurs actifs.
   */
  async channelReport(f: TransactionFilters & { channel: string }) {
    const lang = f.lang || 'fr';
    const channel = this.parseChannel(f.channel, lang);
    const page = Math.max(1, Number(f.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 20));

    const { period, rows, truncated } = await this.loadOperations({ ...f, platform: channel });
    const summary = this.summarize(rows, f.groupBy);
    const accounts = await this.loadAccounts({ from: period.start, to: period.end, channel, lang });

    return {
      message: this.i18nService.translate('admin_report_retrieved', lang),
      data: {
        channel,
        label: CHANNEL_LABELS[channel],
        period: { from: period.start, to: period.end },
        filters: this.cleanFilters(f),
        activeUsers: await this.activeUsersOnChannel(channel, period.gte, period.lt),
        accounts: this.accountsSummary(accounts.rows),
        operations: {
          totalOperations: summary.totalOperations,
          byCurrency: summary.byCurrency,
          byType: summary.byType,
          timeline: summary.timeline,
          topUsers: summary.topUsers,
          data: rows.slice((page - 1) * limit, page * limit).map((r) => this.publicRow(r)),
          total: rows.length,
          page,
          limit,
          totalPages: Math.ceil(rows.length / limit),
          hasNextPage: page * limit < rows.length,
          hasPreviousPage: page > 1,
          truncated,
        },
      },
    };
  }

  /** Mobile Banking et Net Banking côte à côte (même période, mêmes filtres). */
  async channelsComparison(f: TransactionFilters) {
    const lang = f.lang || 'fr';
    const { period, rows, truncated } = await this.loadOperations({ ...f, platform: undefined });
    const accounts = await this.loadAccounts({ from: period.start, to: period.end, lang });

    const channels: AppPlatform[] = ['MOBILE', 'WEB', 'BACK_OFFICE', 'UNKNOWN'];
    const result: Record<string, any> = {};
    for (const ch of channels) {
      const ops = rows.filter((r) => r.platform === ch);
      const acc = accounts.rows.filter((r) => r.channel === ch);
      if ((ch === 'BACK_OFFICE' || ch === 'UNKNOWN') && !ops.length && !acc.length) continue;
      const sum = this.summarize(ops, f.groupBy);
      result[ch] = {
        label: CHANNEL_LABELS[ch],
        activeUsers: ch === 'MOBILE' || ch === 'WEB' ? await this.activeUsersOnChannel(ch, period.gte, period.lt) : null,
        accounts: this.accountsSummary(acc),
        operations: {
          totalOperations: sum.totalOperations,
          byCurrency: sum.byCurrency,
          byType: sum.byType,
        },
      };
    }

    return {
      message: this.i18nService.translate('admin_report_retrieved', lang),
      data: {
        period: { from: period.start, to: period.end },
        filters: this.cleanFilters(f),
        truncated,
        totals: {
          operations: rows.length,
          accountsCreated: accounts.rows.length,
        },
        channels: result,
      },
    };
  }

  /** Export CSV des opérations d'un canal. */
  async channelCsv(f: TransactionFilters & { channel: string }) {
    const lang = f.lang || 'fr';
    const channel = this.parseChannel(f.channel, lang);
    const csv = await this.transactionsCsv({ ...f, platform: channel });
    const slug = channel === 'WEB' ? 'net-banking' : channel === 'MOBILE' ? 'mobile-banking' : channel.toLowerCase();
    csv.data.filename = csv.data.filename.replace(/^transactions_/, `operations_${slug}_`);
    return csv;
  }

  /** Comptes créés : liste paginée filtrable par canal (Mobile / Net Banking). */
  async accountsByChannel(params: {
    from?: string; to?: string; channel?: string; status?: string; search?: string;
    page?: number; limit?: number; lang?: string;
  }) {
    const lang = params.lang || 'fr';
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(params.limit) || 20));
    const { period, rows } = await this.loadAccounts(params);

    const byChannel: Record<string, { label: string; count: number }> = {};
    for (const r of rows) {
      byChannel[r.channel] ??= { label: r.channelLabel, count: 0 };
      byChannel[r.channel].count += 1;
    }

    return {
      message: this.i18nService.translate('admin_report_retrieved', lang),
      data: {
        period: { from: period.start, to: period.end },
        channel: params.channel ? this.parseChannel(params.channel, lang) : null,
        summary: { total: rows.length, byChannel, ...this.accountsSummary(rows) },
        data: rows.slice((page - 1) * limit, page * limit),
        total: rows.length,
        page,
        limit,
        totalPages: Math.ceil(rows.length / limit),
        hasNextPage: page * limit < rows.length,
        hasPreviousPage: page > 1,
      },
    };
  }

  async accountsCsv(params: { from?: string; to?: string; channel?: string; status?: string; search?: string; lang?: string }) {
    const lang = params.lang || 'fr';
    const { period, rows } = await this.loadAccounts(params);
    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const header = ['Date de création', 'Canal', 'Code client', 'Nom', 'Téléphone', 'Email', 'Statut', 'Approuvé le', 'Dernière connexion'];
    const lines = rows.map((r) => [
      iso(r.createdAt), r.channelLabel, r.clientId, r.name, r.phone, r.email, r.status, iso(r.approvedAt), iso(r.lastLoginAt),
    ].map(esc).join(';'));
    const ch = params.channel ? this.parseChannel(params.channel, lang) : null;
    const slug = ch === 'WEB' ? 'net-banking' : ch === 'MOBILE' ? 'mobile-banking' : ch ? ch.toLowerCase() : 'tous-canaux';
    return {
      message: this.i18nService.translate('admin_report_retrieved', lang),
      data: {
        filename: `comptes_${slug}_${period.start}_${period.end}.csv`,
        contentType: 'text/csv; charset=utf-8',
        rows: rows.length,
        content: '﻿' + [header.join(';'), ...lines].join('\r\n'),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. EMAIL : état + test
  // ═══════════════════════════════════════════════════════════════

  async emailStatus(params: { verify?: boolean; lang?: string }) {
    if (params.verify !== false) await this.mailService.verifyConnection();
    return {
      message: this.i18nService.translate('admin_email_status', params.lang || 'fr'),
      data: this.mailService.getStatus(),
    };
  }

  async sendTestEmail(params: { to: string; adminId: string; lang?: string }) {
    const lang = params.lang || 'fr';
    if (!params.to || !String(params.to).includes('@')) {
      throw this.rpcError(this.i18nService.translate('admin_email_invalid', lang), 400);
    }
    const ok = await this.mailService.sendBrandedEmail(
      params.to,
      'AccesFinance — email de test',
      {
        lang,
        title: 'Email de test',
        greeting: 'Bonjour,',
        paragraphs: [
          "Cet email confirme que l'envoi d'emails d'AccesFinance fonctionne correctement.",
          `Envoyé le ${new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Lubumbashi' })}.`,
        ],
        signature: "L'équipe AccesFinance",
      },
    );
    const status = this.mailService.getStatus();
    if (!ok) {
      throw this.rpcError(
        this.i18nService.translate('admin_email_failed', lang, { error: status.lastSendError || 'SMTP' }),
        502,
      );
    }
    return {
      message: this.i18nService.translate('admin_email_sent', lang, { to: params.to }),
      data: status,
    };
  }
}
