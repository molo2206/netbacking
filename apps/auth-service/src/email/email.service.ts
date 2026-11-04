// apps/auth-service/src/email/email.service.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { getLogoPath } from '../../../../libs/common/src/branding/brand';
import {
  EMAIL_LOGO_CID,
  EmailContent,
  renderEmail,
} from '../../../../libs/common/src/branding/email-layout';

/**
 * ═══════════════════════════════════════════════════════════════════
 * ENVOI D'EMAILS ACCESFINANCE
 * ═══════════════════════════════════════════════════════════════════
 * Variables .env (MAILER_* ou SMTP_*) :
 *   MAILER_HOST=smtp.gmail.com
 *   MAILER_PORT=587            (465 = SSL direct)
 *   MAILER_SECURE=false        (true avec le port 465)
 *   MAILER_USER=compte@gmail.com
 *   MAILER_PASS=mot-de-passe-d-application   (les espaces sont retirés)
 *   MAILER_FROM="AccesFinance <compte@gmail.com>"   (optionnel)
 *
 * Corrections par rapport à l'ancienne version :
 *  - un échec de vérification au démarrage NE désactive PLUS l'envoi
 *  - le port est converti en nombre, `secure` déduit du port 465
 *  - nouvelle tentative automatique sur erreur réseau passagère
 *  - erreurs SMTP détaillées dans les logs (authentification, port bloqué…)
 *  - gabarit AccesFinance avec logo intégré à chaque email
 * ═══════════════════════════════════════════════════════════════════
 */

export interface MailStatus {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  from: string;
  lastVerifyOk: boolean | null;
  lastVerifyError: string | null;
  lastSendOk: boolean | null;
  lastSendError: string | null;
  lastSendAt: string | null;
  logoFound: boolean;
}

const TRANSIENT_CODES = ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNRESET', 'EDNS', 'ECONNREFUSED'];

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private status: MailStatus;

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.status = this.buildStatus();
    if (this.status.configured) {
      this.logger.log(
        `📧 SMTP ${this.status.host}:${this.status.port} (secure=${this.status.secure}) — ${this.status.user}`,
      );
      // Vérification informative : un échec n'empêche pas les envois
      void this.verifyConnection();
    } else {
      this.logger.warn('⚠️ MAILER_USER / MAILER_PASS absents du .env : aucun email ne sera envoyé.');
    }
  }

  // ─────────────────────────── configuration ───────────────────────────

  private env(...keys: string[]): string | undefined {
    for (const k of keys) {
      const v = this.configService?.get<string>(k) ?? process.env[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return undefined;
  }

  private buildStatus(): MailStatus {
    const user = this.env('MAILER_USER', 'SMTP_USER') || null;
    const pass = this.env('MAILER_PASS', 'MAILER_PASSWORD', 'SMTP_PASSWORD', 'SMTP_PASS');
    const host = this.env('MAILER_HOST', 'SMTP_HOST') || 'smtp.gmail.com';
    const port = parseInt(this.env('MAILER_PORT', 'SMTP_PORT') || '587', 10) || 587;
    const secureRaw = (this.env('MAILER_SECURE', 'SMTP_SECURE') || '').toLowerCase();
    const secure = secureRaw === 'true' || port === 465;
    const from = this.env('MAILER_FROM', 'SMTP_FROM') || `"AccesFinance" <${user || 'no-reply@accesfinance.africa'}>`;

    return {
      configured: !!(user && pass),
      host,
      port,
      secure,
      user,
      from,
      lastVerifyOk: null,
      lastVerifyError: null,
      lastSendOk: null,
      lastSendError: null,
      lastSendAt: null,
      logoFound: !!getLogoPath('email'),
    };
  }

  private getTransporter(): nodemailer.Transporter | null {
    if (!this.status.configured) return null;
    if (this.transporter) return this.transporter;

    const pass = (this.env('MAILER_PASS', 'MAILER_PASSWORD', 'SMTP_PASSWORD', 'SMTP_PASS') || '')
      // Les mots de passe d'application Google s'affichent avec des espaces
      .replace(/\s+/g, '');

    this.transporter = nodemailer.createTransport({
      host: this.status.host,
      port: this.status.port,
      secure: this.status.secure,
      requireTLS: !this.status.secure,
      auth: { user: this.status.user!, pass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 30000,
    });
    return this.transporter;
  }

  private describeError(error: any): string {
    const code = error?.code ? `[${error.code}] ` : '';
    const response = error?.response ? ` — ${String(error.response).slice(0, 200)}` : '';
    let hint = '';
    if (error?.code === 'EAUTH' || error?.responseCode === 535) {
      hint = ' → identifiants refusés : utilisez un « mot de passe d\'application » Google (validation en 2 étapes activée).';
    } else if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED'].includes(error?.code)) {
      hint = ` → le serveur n'arrive pas à joindre ${this.status.host}:${this.status.port} (port SMTP bloqué par l'hébergeur ?). Essayez MAILER_PORT=465 et MAILER_SECURE=true.`;
    }
    return `${code}${error?.message || error}${response}${hint}`;
  }

  async verifyConnection(): Promise<boolean> {
    const t = this.getTransporter();
    if (!t) return false;
    try {
      await t.verify();
      this.status.lastVerifyOk = true;
      this.status.lastVerifyError = null;
      this.logger.log('✅ Connexion SMTP vérifiée');
      return true;
    } catch (error) {
      this.status.lastVerifyOk = false;
      this.status.lastVerifyError = this.describeError(error);
      this.logger.error(`❌ Vérification SMTP échouée : ${this.status.lastVerifyError}`);
      return false;
    }
  }

  /** État du service (utilisé par l'admin : GET admin/monitoring/email). */
  getStatus(): MailStatus {
    return { ...this.status, logoFound: !!getLogoPath('email') };
  }

  // ─────────────────────────── envoi ───────────────────────────

  private logoAttachment(): any[] {
    const logo = getLogoPath('email');
    return logo ? [{ filename: 'accesfinance-logo.png', path: logo, cid: EMAIL_LOGO_CID }] : [];
  }

  private async deliver(mail: nodemailer.SendMailOptions, attempt = 1): Promise<boolean> {
    const t = this.getTransporter();
    if (!t) {
      this.logger.warn(`⚠️ Email non envoyé à ${mail.to} : SMTP non configuré (MAILER_USER / MAILER_PASS)`);
      return false;
    }
    try {
      const info = await t.sendMail({ from: this.status.from, ...mail });
      this.status.lastSendOk = true;
      this.status.lastSendError = null;
      this.status.lastSendAt = new Date().toISOString();
      this.logger.log(`✅ Email envoyé à ${mail.to} (${info?.messageId || 'sans id'})`);
      return true;
    } catch (error) {
      const description = this.describeError(error);
      if (attempt === 1 && TRANSIENT_CODES.includes(error?.code)) {
        this.logger.warn(`⏳ Échec passager vers ${mail.to}, nouvel essai : ${description}`);
        this.transporter = null; // nouvelle connexion
        await new Promise((r) => setTimeout(r, 2000));
        return this.deliver(mail, 2);
      }
      this.status.lastSendOk = false;
      this.status.lastSendError = description;
      this.status.lastSendAt = new Date().toISOString();
      this.logger.error(`❌ Email non envoyé à ${mail.to} : ${description}`);
      return false;
    }
  }

  /** Email au gabarit AccesFinance (logo, couleurs, pied de page). */
  async sendBrandedEmail(
    to: string,
    subject: string,
    content: EmailContent,
    attachments: nodemailer.SendMailOptions['attachments'] = [],
  ): Promise<boolean> {
    if (!to || !String(to).includes('@')) {
      this.logger.warn(`⚠️ Adresse email invalide : ${to}`);
      return false;
    }
    return this.deliver({
      to,
      subject,
      html: renderEmail({ ...content, recipientEmail: content.recipientEmail ?? to }),
      text: this.toPlainText(content),
      attachments: [...this.logoAttachment(), ...(attachments || [])],
    });
  }

  /**
   * Compatibilité avec les appels existants : `templateName` choisit la mise en page
   * (otp-*, welcome-*, autre) et `context` fournit les textes déjà traduits.
   */
  async sendHtmlEmail(
    to: string,
    subject: string,
    templateName: string,
    context: any = {},
  ): Promise<boolean> {
    return this.sendBrandedEmail(to, subject, this.contentFromTemplate(templateName, context));
  }

  /** Email avec pièce jointe (relevé PDF…). `htmlContent` = texte HTML libre ou paragraphe simple. */
  async sendEmailWithAttachment(
    to: string,
    subject: string,
    htmlContent: string,
    attachment: { filename: string; content: Buffer; contentType: string },
  ): Promise<boolean> {
    const paragraphs = String(htmlContent || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return this.sendBrandedEmail(
      to,
      subject,
      { title: subject, paragraphs },
      [{ filename: attachment.filename, content: attachment.content, contentType: attachment.contentType }],
    );
  }

  // ─────────────────────────── gabarits ───────────────────────────

  private labels(lang: string) {
    const L: Record<string, Record<string, string>> = {
      fr: { password: 'Mot de passe temporaire', identifier: 'Identifiant (code client)', phone: 'Téléphone', sentTo: 'Cet email a été envoyé à' },
      en: { password: 'Temporary password', identifier: 'Login (client code)', phone: 'Phone', sentTo: 'This email was sent to' },
      sw: { password: 'Nenosiri la muda', identifier: 'Kitambulisho (namba ya mteja)', phone: 'Simu', sentTo: 'Barua pepe hii imetumwa kwa' },
    };
    return L[lang] || L.fr;
  }

  private contentFromTemplate(templateName: string, ctx: any): EmailContent {
    const lang = ctx.lang || 'fr';
    const L = this.labels(lang);
    const name = String(templateName || '').toLowerCase();
    const signature = [ctx.thanks, ctx.team].filter(Boolean).join('\n') || undefined;

    if (name.includes('otp')) {
      return {
        lang,
        title: ctx.title || 'Code de vérification',
        preheader: ctx.message,
        greeting: ctx.greeting,
        paragraphs: [ctx.message].filter(Boolean),
        highlight: { value: String(ctx.otpCode || '') },
        afterParagraphs: [ctx.expiry, ctx.ignore].filter(Boolean),
        signature,
        footerNote: ctx.footer,
        recipientEmail: ctx.email,
        sentToLabel: ctx.sent_to || L.sentTo,
      };
    }

    if (name.includes('welcome') || name.includes('password') || name.includes('createcount')) {
      const details = [
        ctx.account_label ? { label: L.identifier, value: ctx.account_label } : null,
        ctx.phone_label ? { label: L.phone, value: ctx.phone_label } : null,
      ].filter(Boolean) as Array<{ label: string; value: any }>;
      return {
        lang,
        title: ctx.title || 'Bienvenue',
        greeting: ctx.greeting,
        paragraphs: [ctx.message, ctx.credentials_label].filter(Boolean),
        details,
        highlight: ctx.password_label
          ? { label: L.password, value: String(ctx.password_label), monospace: false }
          : undefined,
        signature,
        footerNote: ctx.footer,
        recipientEmail: ctx.email,
        sentToLabel: ctx.sent_to || L.sentTo,
      };
    }

    return {
      lang,
      title: ctx.title || '',
      greeting: ctx.greeting,
      paragraphs: [ctx.message].filter(Boolean),
      signature,
      footerNote: ctx.footer,
      recipientEmail: ctx.email,
      sentToLabel: ctx.sent_to || L.sentTo,
    };
  }

  private toPlainText(c: EmailContent): string {
    return [
      c.title,
      c.greeting,
      ...(c.paragraphs || []),
      c.highlight ? `${c.highlight.label ? c.highlight.label + ' : ' : ''}${c.highlight.value}` : '',
      ...(c.details || []).map((d) => `${d.label} : ${d.value}`),
      ...(c.afterParagraphs || []),
      c.signature,
      c.footerNote,
      '— AccesFinance',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
