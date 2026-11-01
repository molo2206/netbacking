// apps/transaction-service/src/bank/bank.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { EncryptionService } from './encryption.service';

export type BankPlatform = 'Mobile' | 'Online';

/** Statistiques d'appels à l'API banque (mémoire du processus, depuis le démarrage). */
interface EndpointStats {
  calls: number;
  success: number;
  failures: number;
  timeouts: number;
  totalDurationMs: number;
  lastStatus: number | null;
  lastDurationMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

@Injectable()
export class BankService {
  private readonly logger = new Logger(BankService.name);
  private readonly baseUrlMobile: string;
  private readonly baseUrlOnline: string;
  private readonly apiKey: string;
  private readonly authToken: string;
  private readonly encryptionService: EncryptionService;
  private readonly timeoutMs: number;
  private readonly historyDefaultDays: number;
  private readonly startedAt = new Date().toISOString();
  private readonly stats = new Map<string, EndpointStats>();
  private readonly recentErrors: Array<{
    at: string;
    endpoint: string;
    status: number | null;
    durationMs: number;
    error: string;
  }> = [];

  constructor(encryptionService: EncryptionService) {
    this.baseUrlMobile =
      process.env.BANK_BASE_URL_MOBILE ||
      process.env.BANK_BASE_URL ||
      'https://mobilebankingapi.accesfinance.africa/Service1.asmx';
    this.baseUrlOnline =
      process.env.BANK_BASE_URL_ONLINE ||
      'https://onlinebankingapi.accesfinance.africa/Service1.asmx';

    this.apiKey = process.env.BANK_API_KEY || '';
    this.authToken = process.env.BANK_AUTH_TOKEN || '';
    this.encryptionService = encryptionService;
    this.timeoutMs = parseInt(process.env.BANK_TIMEOUT_MS || '15000', 10);
    // Période par défaut de l'historique quand aucune date n'est fournie
    // (la banque exige startDate ET endDate sur GetAccountTransactions)
    this.historyDefaultDays = parseInt(
      process.env.BANK_HISTORY_DEFAULT_DAYS || '365',
      10,
    );

    if (!this.apiKey) this.logger.warn('BANK_API_KEY manquante');
    if (!this.authToken) this.logger.warn('BANK_AUTH_TOKEN manquant');

    this.logger.log(
      `BankService initialisé — timeout: ${this.timeoutMs}ms — mobile: ${this.baseUrlMobile} — online: ${this.baseUrlOnline}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // SUPERVISION (utilisé par l'admin : santé de l'API banque)
  // ═══════════════════════════════════════════════════════════════

  private recordCall(
    endpoint: string,
    ok: boolean,
    durationMs: number,
    status: number | null,
    error?: string,
    timeout = false,
  ) {
    const name = endpoint.split('?')[0];
    const st: EndpointStats = this.stats.get(name) || {
      calls: 0, success: 0, failures: 0, timeouts: 0, totalDurationMs: 0,
      lastStatus: null, lastDurationMs: null, lastSuccessAt: null, lastFailureAt: null, lastError: null,
    };
    const now = new Date().toISOString();
    st.calls += 1;
    st.totalDurationMs += durationMs;
    st.lastStatus = status;
    st.lastDurationMs = durationMs;
    if (ok) {
      st.success += 1;
      st.lastSuccessAt = now;
    } else {
      st.failures += 1;
      if (timeout) st.timeouts += 1;
      st.lastFailureAt = now;
      st.lastError = (error || '').slice(0, 300);
      this.recentErrors.unshift({ at: now, endpoint: name, status, durationMs, error: st.lastError });
      if (this.recentErrors.length > 50) this.recentErrors.pop();
    }
    this.stats.set(name, st);
  }

  /** Statistiques depuis le démarrage du service. */
  getStats() {
    const endpoints = Array.from(this.stats.entries()).map(([endpoint, st]) => ({
      endpoint,
      ...st,
      avgDurationMs: st.calls ? Math.round(st.totalDurationMs / st.calls) : null,
      successRate: st.calls ? Math.round((st.success / st.calls) * 10000) / 100 : null,
    }));
    const totals = endpoints.reduce(
      (t, e) => ({
        calls: t.calls + e.calls,
        success: t.success + e.success,
        failures: t.failures + e.failures,
        timeouts: t.timeouts + e.timeouts,
      }),
      { calls: 0, success: 0, failures: 0, timeouts: 0 },
    );
    return {
      since: this.startedAt,
      timeoutMs: this.timeoutMs,
      baseUrls: { mobile: this.baseUrlMobile, online: this.baseUrlOnline },
      totals: {
        ...totals,
        successRate: totals.calls ? Math.round((totals.success / totals.calls) * 10000) / 100 : null,
      },
      endpoints: endpoints.sort((a, b) => b.calls - a.calls),
      recentErrors: this.recentErrors.slice(0, 20),
    };
  }

  /**
   * Test en direct : GetClientAccounts sur un client de test
   * (BANK_HEALTH_CLIENT_ID dans le .env). Retourne la latence et le statut.
   */
  async ping(platform: BankPlatform = 'Mobile') {
    const clientId = process.env.BANK_HEALTH_CLIENT_ID;
    if (!clientId) {
      return { tested: false, reason: 'BANK_HEALTH_CLIENT_ID non configuré dans le .env' };
    }
    const started = Date.now();
    try {
      await this.getClientAccounts(clientId, undefined, 'fr', platform);
      return { tested: true, platform, ok: true, durationMs: Date.now() - started };
    } catch (err) {
      const e: any = err;
      const details = typeof e?.getError === 'function' ? e.getError() : null;
      return {
        tested: true,
        platform,
        ok: false,
        durationMs: Date.now() - started,
        error: details?.message || e?.message || String(e),
        statusCode: details?.statusCode ?? null,
      };
    }
  }

  private resolveBaseUrl(platform: BankPlatform = 'Mobile'): string {
    return platform === 'Online' ? this.baseUrlOnline : this.baseUrlMobile;
  }

  private generateRequestId(): string {
    return crypto.randomUUID();
  }

  /** Formate une date en 'yyyy-MM-dd' (heure locale du serveur, pas UTC). */
  private formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Normalise une date reçue (ISO, 'yyyy-MM-dd'…) en 'yyyy-MM-dd', ou null si invalide. */
  private normalizeDate(value?: string): string | null {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (isNaN(parsed.getTime())) return null;
    return this.formatDate(parsed);
  }

  /**
   * Garantit une période valide pour GetAccountTransactions :
   * - endDate absent   → aujourd'hui
   * - startDate absent → endDate - BANK_HISTORY_DEFAULT_DAYS jours
   * - startDate > endDate → inversion
   */
  private resolveDateRange(
    startDate?: string,
    endDate?: string,
  ): { startDate: string; endDate: string } {
    let end = this.normalizeDate(endDate) || this.formatDate(new Date());
    let start = this.normalizeDate(startDate);

    if (!start) {
      const base = new Date(`${end}T00:00:00`);
      base.setDate(base.getDate() - this.historyDefaultDays);
      start = this.formatDate(base);
    }

    if (start > end) [start, end] = [end, start];

    return { startDate: start, endDate: end };
  }

  private translate(key: string, lang: string): string {
    const messages: Record<string, Record<string, string>> = {
      bank_timeout: {
        fr: 'Le service bancaire ne répond pas. Veuillez réessayer dans quelques instants.',
        en: 'The bank service is not responding. Please try again in a few moments.',
      },
      bank_unavailable: {
        fr: 'Le service bancaire est temporairement indisponible. Veuillez réessayer plus tard.',
        en: 'The bank service is temporarily unavailable. Please try again later.',
      },
      bank_invalid_response: {
        fr: 'La réponse de la banque est illisible. Veuillez réessayer.',
        en: 'The bank response is unreadable. Please try again.',
      },
      bank_duplicate_request: {
        fr: 'Cette opération a déjà été traitée (requestId dupliqué).',
        en: 'This operation has already been processed (duplicate requestId).',
      },
      bank_business_rule: {
        fr: 'Opération refusée par la banque (règle métier).',
        en: 'Operation rejected by the bank (business rule).',
      },
    };
    return messages[key]?.[lang] || messages[key]?.fr || key;
  }

  private buildHeaders(contentType: string): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': contentType,
    };
    if (this.authToken) {
      headers['Authorization'] = this.authToken.startsWith('Bearer ')
        ? this.authToken
        : `Bearer ${this.authToken}`;
    }
    return headers;
  }

  private async parseResponse(
    response: Response,
    rawResponse: string,
    lang: string,
  ): Promise<any> {
    if (!response.ok) {
      let errBody: any = rawResponse;
      try {
        errBody = JSON.parse(rawResponse);
      } catch {
        /* garde la chaîne brute */
      }

      this.logger.error(
        `Erreur banque ${response.status}: ${JSON.stringify(errBody).substring(0, 300)}`,
      );

      if (response.status === 401) {
        throw new RpcException({
          status: 'error',
          message: errBody?.message || this.translate('bank_unavailable', lang),
          statusCode: 401,
          details: errBody,
        });
      }
      if (response.status === 409) {
        throw new RpcException({
          status: 'error',
          message: this.translate('bank_duplicate_request', lang),
          statusCode: 409,
          details: errBody,
        });
      }
      if (response.status === 422) {
        throw new RpcException({
          status: 'error',
          message:
            errBody?.message || this.translate('bank_business_rule', lang),
          statusCode: 422,
          details: errBody,
        });
      }
      throw new RpcException({
        status: 'error',
        message: errBody?.message || this.translate('bank_unavailable', lang),
        statusCode: response.status,
        details: errBody,
      });
    }

    let finalResponse: any;
    try {
      finalResponse = JSON.parse(rawResponse);
      this.logger.log('Réponse en JSON clair');
    } catch {
      try {
        finalResponse = this.encryptionService.decryptResponse(rawResponse);
        this.logger.log('Réponse déchiffrée avec succès');
      } catch {
        this.logger.error('Impossible de décoder la réponse banque');
        throw new RpcException({
          status: 'error',
          message: this.translate('bank_invalid_response', lang),
          statusCode: 500,
        });
      }
    }

    // ✅ Si le résultat est une chaîne JSON (double-encodage), on la re-parse
    if (typeof finalResponse === 'string') {
      try {
        const reparsed = JSON.parse(finalResponse);
        this.logger.log('Double JSON détecté dans parseResponse — re-parsing effectué');
        finalResponse = reparsed;
      } catch (e) {
        this.logger.warn(`Impossible de re-parser la chaîne JSON: ${e.message}`);
      }
    }

    this.logger.log(`Réponse banque finale: ${JSON.stringify(finalResponse)}`);
    return finalResponse;
  }

  private async callBankApi(
    endpoint: string,
    payload?: any,
    lang: string = 'fr',
    platform: BankPlatform = 'Mobile',
  ): Promise<any> {
    const baseUrl = this.resolveBaseUrl(platform);
    let url: string;
    let body: string | undefined;
    let method: string = 'GET';
    let contentType: string = 'text/plain';

    if (payload) {
      method = 'POST';
      url = `${baseUrl}/${endpoint}`;
      body = this.encryptionService.encryptRequest(payload);
      contentType = process.env.BANK_CONTENT_TYPE || 'text/plain';
      this.logger.log(`Corps chiffré: ${body.substring(0, 60)}...`);
    } else {
      url = `${baseUrl}/${endpoint}`;
    }

    this.logger.log(`Appel API banque: ${method} ${url}`);

    const headers = this.buildHeaders(contentType);
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        const rawResponse = await response.text();
        const durationMs = Date.now() - startTime;

        this.logger.log(
          `Statut banque: ${response.status} (${durationMs}ms)`,
        );
        this.logger.log(
          `Réponse brute: ${rawResponse.substring(0, 100)}...`,
        );

        try {
          const parsed = await this.parseResponse(response, rawResponse, lang);
          this.recordCall(endpoint, true, durationMs, response.status);
          return parsed;
        } catch (parseErr) {
          this.recordCall(
            endpoint, false, durationMs, response.status,
            response.ok ? 'Réponse illisible' : rawResponse.substring(0, 300),
          );
          throw parseErr;
        }
      } catch (error) {
        if (error instanceof RpcException) throw error;

        const isTimeout = error?.name === 'AbortError' || error?.code === 'ETIMEDOUT';
        this.recordCall(endpoint, false, Date.now() - startTime, null, error?.message, isTimeout);

        this.logger.error(
          `Échec API banque (tentative ${attempt}/${maxRetries}, ${Date.now() - startTime}ms): ${error.message}`,
        );

        if (error?.name === 'AbortError' || error?.code === 'ETIMEDOUT') {
          this.logger.error('TIMEOUT API banque — abandon des retries');
          throw new RpcException({
            status: 'error',
            message: this.translate('bank_timeout', lang),
            statusCode: 504,
          });
        }

        if (attempt < maxRetries) {
          const delay = 500 * attempt;
          this.logger.log(`Nouvel essai dans ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new RpcException({
      status: 'error',
      message: this.translate('bank_unavailable', lang),
      statusCode: 502,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // COMPTES / CLIENTS
  // ═══════════════════════════════════════════════════════════════

  async getClientDetails(
    clientId: string,
    requestId?: string,
    lang: string = 'fr',
    platform: BankPlatform = 'Mobile',
  ): Promise<any> {
    const reqId = requestId || this.generateRequestId();
    const endpoint = `GetClientdetails?clientId=${encodeURIComponent(
      clientId,
    )}&requestId=${encodeURIComponent(reqId)}`;
    return this.callBankApi(endpoint, undefined, lang, platform);
  }

  async getClientAccounts(
    clientId: string,
    requestId?: string,
    lang: string = 'fr',
    platform: BankPlatform = 'Mobile',
  ): Promise<any> {
    const reqId = requestId || this.generateRequestId();
    const endpoint = `GetClientAccounts?clientId=${encodeURIComponent(
      clientId,
    )}&requestId=${encodeURIComponent(reqId)}`;
    return this.callBankApi(endpoint, undefined, lang, platform);
  }

  async getAccountDetails(
    accountNumber: string,
    requestId?: string,
    lang: string = 'fr',
    platform: BankPlatform = 'Mobile',
  ): Promise<any> {
    const reqId = requestId || this.generateRequestId();
    const endpoint = `GetAccountDetails?accountNumber=${encodeURIComponent(
      accountNumber,
    )}&requestId=${encodeURIComponent(reqId)}`;
    return this.callBankApi(endpoint, undefined, lang, platform);
  }

  // ═══════════════════════════════════════════════════════════════
  // TRANSFERT (chiffré)
  // ═══════════════════════════════════════════════════════════════

  async bankTransfer(params: {
    requestId?: string;
    senderAccountNumber: string;
    receiverAccountNumber: string;
    amount: number;
    currency: 'USD' | 'CDF';
    description?: string;
    type?: string;
    platform?: BankPlatform;
    lang?: string;
  }): Promise<any> {
    const lang = params.lang || 'fr';
    const payload = {
      requestId: params.requestId || this.generateRequestId(),
      senderAccountNumber: params.senderAccountNumber.trim(),
      receiverAccountNumber: params.receiverAccountNumber.trim(),
      amount: params.amount,
      currency: params.currency,
      description: params.description || 'Wallet transfer',
      type: params.type || 'TRANSFER',
      platform: params.platform || 'Mobile',
    };
    return this.callBankApi('Transfer', payload, lang, params.platform);
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTORIQUE
  // ═══════════════════════════════════════════════════════════════

  async getAccountTransactions(params: {
    accountNumber: string;
    requestId?: string;
    page?: number;
    limit?: number;
    startDate?: string;
    endDate?: string;
    type?: string;
    movement?: 'CREDIT' | 'DEBIT';
    status?: string;
    lang?: string;
    platform?: BankPlatform;
  }): Promise<any> {
    const lang = params.lang || 'fr';
    const reqId = params.requestId || this.generateRequestId();
    // ⚠️ Service .asmx (ASP.NET) : TOUS les paramètres de la méthode doivent être
    // présents dans l'URL, même vides, sinon 500 "Missing parameter: xxx".
    // → on envoie toujours page, limit, startDate, endDate, type, movement, status.
    const range = this.resolveDateRange(params.startDate, params.endDate);
    const qs = new URLSearchParams({
      accountNumber: params.accountNumber.trim(),
      requestId: reqId,
      page: String(params.page ?? 1),
      limit: String(params.limit ?? 10),
      startDate: range.startDate,
      endDate: range.endDate,
      type: params.type ?? '',
      movement: params.movement ?? '',
      status: params.status ?? '',
    });
    return this.callBankApi(
      `GetAccountTransactions?${qs.toString()}`,
      undefined,
      lang,
      params.platform,
    );
  }

  async getTransactionDetails(
    transactionId: string,
    lang: string = 'fr',
    platform: BankPlatform = 'Mobile',
    requestId?: string,
  ): Promise<any> {
    // ⚠️ .asmx : requestId obligatoire, sinon 500 "Missing parameter: requestId"
    const reqId = requestId || this.generateRequestId();
    const endpoint = `GetTransactionDetails?transactionId=${encodeURIComponent(
      String(transactionId).trim(),
    )}&requestId=${encodeURIComponent(reqId)}`;
    return this.callBankApi(endpoint, undefined, lang, platform);
  }

  // ═══════════════════════════════════════════════════════════════
  // WALLET
  // ═══════════════════════════════════════════════════════════════

  async linkAccount(
    accountNumber: string,
    requestId?: string,
    lang: string = 'fr',
    platform: BankPlatform = 'Mobile',
  ): Promise<any> {
    const cleanAccountNumber = accountNumber.trim();
    this.logger.log(
      `Liaison compte: "${accountNumber}" -> "${cleanAccountNumber}"`,
    );
    const reqId = requestId || this.generateRequestId();
    const endpoint = `WalletLinking?accountNumber=${encodeURIComponent(
      cleanAccountNumber,
    )}&requestId=${encodeURIComponent(reqId)}`;
    return this.callBankApi(endpoint, undefined, lang, platform);
  }

  async topup(
    accountNumber: string,
    amount: number,
    currency: 'USD' | 'CDF',
    requestId?: string,
    lang: string = 'fr',
    platform: BankPlatform = 'Mobile',
  ): Promise<any> {
    const cleanAccountNumber = accountNumber.trim();
    this.logger.log(
      `Topup compte ${cleanAccountNumber} montant ${amount} ${currency}`,
    );
    const payload = {
      requestId: requestId || this.generateRequestId(),
      accountNumber: cleanAccountNumber,
      amount,
      currency,
      platform,
    };
    return this.callBankApi('WalletTopup', payload, lang, platform);
  }

  async cashout(
    accountNumber: string,
    amount: number,
    currency: 'USD' | 'CDF',
    requestId?: string,
    lang: string = 'fr',
    platform: BankPlatform = 'Mobile',
  ): Promise<any> {
    const cleanAccountNumber = accountNumber.trim();
    this.logger.log(
      `Cashout compte ${cleanAccountNumber} montant ${amount} ${currency}`,
    );
    const payload = {
      requestId: requestId || this.generateRequestId(),
      accountNumber: cleanAccountNumber,
      amount,
      currency,
      platform,
    };
    return this.callBankApi('WalletCashout', payload, lang, platform);
  }
}