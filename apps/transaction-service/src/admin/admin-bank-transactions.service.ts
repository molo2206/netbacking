/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/transaction-service/src/admin/admin-bank-transactions.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service';
import { BankService } from '../bank/bank.service';
import {
  BankFilterError,
  canonicalBankType,
  normalizeBankLimit,
  normalizeBankMovement,
  normalizeBankStatus,
  normalizeBankTypes,
} from '../../../../libs/common/src/bank/bank-filters';

/**
 * ═══════════════════════════════════════════════════════════════════
 * ADMIN — TOUTES LES TRANSACTIONS BANCAIRES
 * ═══════════════════════════════════════════════════════════════════
 * La banque n'expose pas de liste globale : l'historique se lit compte
 * par compte. Ce service :
 *   1. rassemble les clients connus (utilisateurs de l'app + table clients)
 *   2. lit leurs comptes (GetClientAccounts)
 *   3. lit l'historique complet de chaque compte sur la période
 *   4. fusionne, filtre, trie, pagine et calcule les volumes
 *
 * Protection de l'API banque :
 *   - cache des comptes (5 min) et des historiques (2 min)
 *   - nombre d'appels simultanés limité (ADMIN_TX_CONCURRENCY, défaut 4)
 *   - période par défaut 30 jours, maximum 366 jours
 * Un compte en erreur n'empêche pas l'affichage des autres (liste `bankErrors`).
 * ═══════════════════════════════════════════════════════════════════
 */

const TZ_OFFSET = process.env.APP_TZ_OFFSET || '+02:00';
const ACCOUNTS_TTL_MS = parseInt(process.env.ADMIN_TX_ACCOUNTS_CACHE_MS || '300000', 10);
const HISTORY_TTL_MS = parseInt(process.env.ADMIN_TX_HISTORY_CACHE_MS || '120000', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.ADMIN_TX_CONCURRENCY || '4', 10));
const MAX_DAYS = 366;

export interface AdminTransactionFilters {
  from?: string;          // AAAA-MM-JJ (défaut : il y a 30 jours)
  to?: string;            // AAAA-MM-JJ (défaut : aujourd'hui)
  clientId?: string;
  userId?: string;
  accountNumber?: string;
  type?: string;          // DEPOSIT, WITHDRAWAL, TRANSFER, PAYMENT, FEE (plusieurs séparés par des virgules)
  movement?: string;      // CREDIT | DEBIT
  status?: string;        // PENDING | COMPLETED | FAILED
  currency?: string;      // USD | CDF
  minAmount?: number | string;
  maxAmount?: number | string;
  search?: string;        // référence, id, description, compte, client
  sort?: 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
  page?: number | string;
  limit?: number | string;
  refresh?: boolean | string; // true = ignorer le cache
  lang?: string;
}

interface ClientInfo {
  clientId: string;
  name: string | null;
  phone: string | null;
  userId: string | null;
}

interface AccountInfo {
  accountNumber: string;
  accountType: string | null;
  currency: string | null;
  balance: number | null;
  status: string | null;
}

interface Row {
  id: string;
  reference: string | null;
  date: string | null;
  _time: number;
  _seq: number;
  type: string | null;
  movement: string | null;
  amount: number;
  currency: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  status: string | null;
  description: string | null;
  accountNumber: string;
  accountType: string | null;
  clientId: string;
  clientName: string | null;
  clientPhone: string | null;
  userId: string | null;
}

@Injectable()
export class AdminBankTransactionsService {
  private readonly logger = new Logger(AdminBankTransactionsService.name);
  private readonly accountsCache = new Map<string, { value: AccountInfo[]; expires: number }>();
  private readonly historyCache = new Map<string, { value: any[]; expires: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bankService: BankService,
  ) {}

  // ─────────────────────────── utilitaires ───────────────────────────

  private rpcError(message: string, statusCode: number) {
    return new RpcException({ status: 'error', message, statusCode });
  }

  private toInt(value: any, fallback: number, max: number): number {
    const n = parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, max);
  }

  private offsetMinutes(): number {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(TZ_OFFSET);
    return m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : 120;
  }

  private localDay(date: Date): string {
    return new Date(date.getTime() + this.offsetMinutes() * 60000).toISOString().slice(0, 10);
  }

  private resolvePeriod(from?: string, to?: string) {
    const isDay = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if ((from && !isDay(from)) || (to && !isDay(to))) {
      throw this.rpcError('Période invalide : utilisez le format AAAA-MM-JJ.', 400);
    }
    const end = to || this.localDay(new Date());
    let start = from;
    if (!start) {
      const d = new Date(`${end}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 29);
      start = d.toISOString().slice(0, 10);
    }
    if (start > end) throw this.rpcError('La date de début doit être antérieure à la date de fin.', 400);
    const days = (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86400000 + 1;
    if (days > MAX_DAYS) throw this.rpcError(`Période trop longue : ${MAX_DAYS} jours maximum.`, 400);
    return { start, end };
  }

  /** Exécute les tâches avec au plus `CONCURRENCY` appels banque en même temps. */
  private async pool<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;
    const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (index < items.length) {
        const i = index++;
        results[i] = await worker(items[i]);
      }
    });
    await Promise.all(runners);
    return results;
  }

  private parseBank(res: any): any {
    let v = res?.data ?? res;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { /* garde la chaîne */ }
    }
    return v;
  }

  private num(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ─────────────────────────── clients & comptes ───────────────────────────

  private async collectClients(f: AdminTransactionFilters): Promise<ClientInfo[]> {
    // Utilisateur précis
    if (f.userId) {
      const u = await this.prisma.user.findUnique({
        where: { id: String(f.userId).trim() },
        select: { id: true, clientId: true, firstName: true, lastName: true, phone: true },
      });
      if (!u?.clientId) return [];
      return [{
        clientId: u.clientId,
        name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || null,
        phone: u.phone,
        userId: u.id,
      }];
    }

    const onlyClient = f.clientId ? String(f.clientId).trim() : null;

    const [users, clients] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          clientId: onlyClient ? onlyClient : { not: null },
          deletedAt: null,
        },
        select: { id: true, clientId: true, firstName: true, lastName: true, phone: true },
      }),
      this.prisma.clients.findMany({
        where: onlyClient ? { clientId: onlyClient } : {},
        select: { clientId: true, firstName: true, lastName: true, phone: true },
      }),
    ]);

    const map = new Map<string, ClientInfo>();
    for (const c of clients) {
      if (!c.clientId) continue;
      map.set(c.clientId, {
        clientId: c.clientId,
        name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || null,
        phone: c.phone || null,
        userId: null,
      });
    }
    for (const u of users) {
      if (!u.clientId) continue;
      const existing = map.get(u.clientId);
      map.set(u.clientId, {
        clientId: u.clientId,
        name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || existing?.name || null,
        phone: u.phone || existing?.phone || null,
        userId: u.id,
      });
    }

    // Client demandé mais inconnu localement : on interroge quand même la banque
    if (onlyClient && !map.has(onlyClient)) {
      map.set(onlyClient, { clientId: onlyClient, name: null, phone: null, userId: null });
    }
    return Array.from(map.values());
  }

  private async clientAccounts(clientId: string, refresh: boolean): Promise<AccountInfo[]> {
    const cached = this.accountsCache.get(clientId);
    if (!refresh && cached && cached.expires > Date.now()) return cached.value;

    const res = await this.bankService.getClientAccounts(clientId);
    const data = this.parseBank(res);
    let raw: any = data?.accounts ?? data ?? [];
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = []; }
    }
    const accounts: AccountInfo[] = (Array.isArray(raw) ? raw : [])
      .map((a: any) => ({
        accountNumber: String(a?.accountNumber ?? '').trim(),
        accountType: a?.accountType ?? null,
        currency: a?.currency ? String(a.currency).trim().toUpperCase() : null,
        balance: this.num(a?.balance),
        status: a?.status ?? null,
      }))
      .filter((a) => a.accountNumber);

    this.accountsCache.set(clientId, { value: accounts, expires: Date.now() + ACCOUNTS_TTL_MS });
    return accounts;
  }

  /** Historique complet d'un compte sur la période (toutes les pages). */
  private async accountHistory(accountNumber: string, start: string, end: string, refresh: boolean): Promise<any[]> {
    const key = `${accountNumber}|${start}|${end}`;
    const cached = this.historyCache.get(key);
    if (!refresh && cached && cached.expires > Date.now()) return cached.value;

    // Document banque : limit <= 100
    const pageSize = normalizeBankLimit(process.env.BANK_HISTORY_PAGE_SIZE || '100');
    const maxPages = parseInt(process.env.BANK_HISTORY_MAX_PAGES || '20', 10);
    const fetchPage = (page: number) =>
      this.bankService.getAccountTransactions({
        accountNumber,
        page,
        limit: pageSize,
        startDate: start,
        endDate: end,
      });

    const first = this.parseBank(await fetchPage(1));
    const firstTx: any[] = first?.transactions ?? [];
    const total: number = first?.pagination?.total ?? firstTx.length;
    const totalPages = Math.min(first?.pagination?.totalPages ?? Math.ceil(total / pageSize), maxPages);

    const pages: any[][] = [firstTx];
    for (let p = 2; p <= totalPages; p++) {
      const res = this.parseBank(await fetchPage(p));
      pages.push(res?.transactions ?? []);
    }
    const all = pages.flat();

    this.historyCache.set(key, { value: all, expires: Date.now() + HISTORY_TTL_MS });
    if (this.historyCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of this.historyCache) if (v.expires <= now) this.historyCache.delete(k);
    }
    return all;
  }

  // ─────────────────────────── chargement + filtres ───────────────────────────

  private async load(f: AdminTransactionFilters) {
    const { start, end } = this.resolvePeriod(f.from, f.to);

    // ✅ Filtres validés selon le document de la banque (section 10)
    let types: string[] = [];
    let movementFilter: string | undefined;
    let statusFilter: string | undefined;
    try {
      types = normalizeBankTypes(f.type);
      movementFilter = normalizeBankMovement(f.movement);
      statusFilter = normalizeBankStatus(f.status);
    } catch (err) {
      if (err instanceof BankFilterError) throw this.rpcError(err.message, 400);
      throw err;
    }
    const refresh = f.refresh === true || f.refresh === 'true';
    const bankErrors: Array<{ clientId?: string; accountNumber?: string; error: string }> = [];

    // 1. Comptes à lire
    type Target = { client: ClientInfo; account: AccountInfo };
    let targets: Target[] = [];

    if (f.accountNumber) {
      const accountNumber = String(f.accountNumber).trim();
      let client: ClientInfo = { clientId: '', name: null, phone: null, userId: null };
      let account: AccountInfo = { accountNumber, accountType: null, currency: null, balance: null, status: null };
      try {
        const acc = this.parseBank(await this.bankService.getAccountDetails(accountNumber));
        if (!acc?.accountNumber) throw this.rpcError(`Compte ${accountNumber} introuvable à la banque.`, 404);
        const clientId = String(acc.clientId ?? acc.client?.clientId ?? '').trim();
        const local = clientId ? (await this.collectClients({ clientId }))[0] : null;
        client = local || {
          clientId,
          name: acc.client ? `${acc.client.firstName || ''} ${acc.client.lastName || ''}`.trim() || null : null,
          phone: acc.client?.phone ?? null,
          userId: null,
        };
        account = {
          accountNumber,
          accountType: acc.accountType ?? null,
          currency: acc.currency ? String(acc.currency).toUpperCase() : null,
          balance: this.num(acc.balance),
          status: acc.status ?? null,
        };
      } catch (err) {
        if (err instanceof RpcException) throw err;
        throw this.rpcError(`Compte ${accountNumber} : ${err?.message || err}`, 502);
      }
      targets = [{ client, account }];
    } else {
      const clients = await this.collectClients(f);
      const perClient = await this.pool(clients, async (client) => {
        try {
          const accounts = await this.clientAccounts(client.clientId, refresh);
          return accounts.map((account) => ({ client, account }));
        } catch (err) {
          bankErrors.push({ clientId: client.clientId, error: String(err?.message || err).slice(0, 200) });
          return [] as Target[];
        }
      });
      targets = perClient.flat();
    }

    // Devise : inutile de lire les comptes d'une autre devise
    const currency = f.currency ? String(f.currency).trim().toUpperCase() : null;
    if (currency) targets = targets.filter((t) => !t.account.currency || t.account.currency === currency);

    // 2. Historiques
    const histories = await this.pool(targets, async (t) => {
      try {
        return { t, txs: await this.accountHistory(t.account.accountNumber, start, end, refresh) };
      } catch (err) {
        bankErrors.push({
          clientId: t.client.clientId,
          accountNumber: t.account.accountNumber,
          error: String(err?.message || err).slice(0, 200),
        });
        return { t, txs: [] as any[] };
      }
    });

    // 3. Fusion
    const clean = (v: any) => (typeof v === 'string' ? v.trim() : v);
    let rows: Row[] = [];
    for (const { t, txs } of histories) {
      txs.forEach((tx: any, seq: number) => {
        const created = tx?.createdAt ? new Date(tx.createdAt) : null;
        rows.push({
          id: String(clean(tx?.id) ?? ''),
          reference: clean(tx?.reference) || clean(tx?.id) || null,
          date: tx?.createdAt ?? null,
          _time: created && !isNaN(created.getTime()) ? created.getTime() : 0,
          _seq: seq,
          type: canonicalBankType(clean(tx?.type)),
          movement: tx?.movement ? String(tx.movement).toUpperCase() : null,
          amount: this.num(tx?.amount) ?? 0,
          currency: String(clean(tx?.currency) || t.account.currency || 'USD').toUpperCase(),
          balanceBefore: this.num(tx?.balanceBefore),
          balanceAfter: this.num(tx?.balanceAfter),
          status: tx?.status ? String(tx.status).toUpperCase() : null,
          description: clean(tx?.description) ?? null,
          accountNumber: t.account.accountNumber,
          accountType: t.account.accountType,
          clientId: t.client.clientId,
          clientName: t.client.name,
          clientPhone: t.client.phone,
          userId: t.client.userId,
        });
      });
    }

    // 4. Filtres
    if (types.length) rows = rows.filter((r) => !!r.type && types.includes(r.type));
    if (movementFilter) rows = rows.filter((r) => r.movement === movementFilter);
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    if (currency) rows = rows.filter((r) => r.currency === currency);
    const min = f.minAmount !== undefined && f.minAmount !== '' ? Number(f.minAmount) : null;
    const max = f.maxAmount !== undefined && f.maxAmount !== '' ? Number(f.maxAmount) : null;
    if (min !== null && Number.isFinite(min)) rows = rows.filter((r) => r.amount >= min);
    if (max !== null && Number.isFinite(max)) rows = rows.filter((r) => r.amount <= max);
    if (f.search && String(f.search).trim()) {
      const q = String(f.search).toLowerCase().trim();
      rows = rows.filter((r) =>
        [r.reference, r.id, r.description, r.accountNumber, r.clientId, r.clientName, r.clientPhone]
          .some((v) => v && String(v).toLowerCase().includes(q)),
      );
    }

    // 5. Tri
    const byDate = (a: Row, b: Row) => (a._time - b._time) || (a._seq - b._seq);
    switch (f.sort) {
      case 'date_asc': rows.sort(byDate); break;
      case 'amount_desc': rows.sort((a, b) => b.amount - a.amount); break;
      case 'amount_asc': rows.sort((a, b) => a.amount - b.amount); break;
      default: rows.sort((a, b) => byDate(b, a));
    }

    return {
      period: { from: start, to: end },
      rows,
      scanned: {
        clients: new Set(targets.map((t) => t.client.clientId)).size,
        accounts: targets.length,
      },
      bankErrors,
    };
  }

  private summarize(rows: Row[]) {
    const round = (n: number) => Math.round(n * 100) / 100;
    const byCurrency: Record<string, { count: number; credit: number; debit: number; net: number }> = {};
    const byType: Record<string, { count: number; amount: Record<string, number> }> = {};
    const byMovement: Record<string, number> = {};

    for (const r of rows) {
      const c = (byCurrency[r.currency] ??= { count: 0, credit: 0, debit: 0, net: 0 });
      c.count += 1;
      if (r.movement === 'CREDIT') c.credit += r.amount;
      else if (r.movement === 'DEBIT') c.debit += r.amount;

      const typeKey = String(r.type || 'AUTRE');
      const t = (byType[typeKey] ??= { count: 0, amount: {} });
      t.count += 1;
      t.amount[r.currency] = (t.amount[r.currency] || 0) + r.amount;

      const mv = r.movement || 'AUTRE';
      byMovement[mv] = (byMovement[mv] || 0) + 1;
    }
    for (const c of Object.values(byCurrency)) {
      c.credit = round(c.credit);
      c.debit = round(c.debit);
      c.net = round(c.credit - c.debit);
    }
    for (const t of Object.values(byType)) {
      for (const k of Object.keys(t.amount)) t.amount[k] = round(t.amount[k]);
    }
    return { totalTransactions: rows.length, byCurrency, byType, byMovement };
  }

  private publicRow(r: Row) {
    const { _time, _seq, ...rest } = r;
    return rest;
  }

  // ─────────────────────────── API ───────────────────────────

  async list(f: AdminTransactionFilters) {
    const page = this.toInt(f.page, 1, 100000);
    const limit = this.toInt(f.limit, 20, 200);
    const { period, rows, scanned, bankErrors } = await this.load(f);

    return {
      success: true,
      message: 'Liste des transactions récupérée avec succès',
      data: {
        period,
        summary: this.summarize(rows),
        scanned,
        bankErrors,
        data: rows.slice((page - 1) * limit, page * limit).map((r) => this.publicRow(r)),
        total: rows.length,
        page,
        limit,
        totalPages: Math.ceil(rows.length / limit),
        hasNextPage: page * limit < rows.length,
        hasPreviousPage: page > 1,
      },
    };
  }

  async csv(f: AdminTransactionFilters) {
    const { period, rows } = await this.load(f);
    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Date', 'Id', 'Référence', 'Type', 'Mouvement', 'Montant', 'Devise', 'Solde avant',
      'Solde après', 'Statut', 'Description', 'Compte', 'Type de compte', 'Code client', 'Client', 'Téléphone'];
    const lines = rows.map((r) => [
      r.date, r.id, r.reference, r.type, r.movement, r.amount.toFixed(2), r.currency, r.balanceBefore,
      r.balanceAfter, r.status, r.description, r.accountNumber, r.accountType, r.clientId, r.clientName, r.clientPhone,
    ].map(esc).join(';'));

    return {
      success: true,
      message: 'Export des transactions',
      data: {
        filename: `transactions_${period.from}_${period.to}.csv`,
        contentType: 'text/csv; charset=utf-8',
        rows: rows.length,
        content: '﻿' + [header.join(';'), ...lines].join('\r\n'),
      },
    };
  }
}
