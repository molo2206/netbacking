// apps/auth-service/src/sms/sms.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { getSharedPrisma } from '../../../../libs/common/src/db/shared-prisma';
import { checkSmsNumber, maskPhone } from '../../../../libs/common/src/utils/phone.util';
import { writeAudit } from '../../../../libs/common/src/audit/write-audit';

interface SmsResponse {
  status: string;
  message_id?: string;
  message?: string;
  [key: string]: any;
}

type SmsKind = 'OTP' | 'PASSWORD' | 'NOTIFICATION';

@Injectable()
export class SmsService {
  private readonly apiId = 'API42928758643';
  private readonly apiPassword = '@@Accesfina!2026';
  private readonly sender = 'ACCESFIN';
  private readonly apiUrl = 'https://papi.dream-digital.info/api/SendSms';
  private readonly logEnabled =
    String(process.env.SMS_LOG_ENABLED ?? 'true').toLowerCase() !== 'false';

  // ─────────────────────────── masquage ───────────────────────────

  private detectKind(message: string): SmsKind {
    const m = message.toLowerCase();
    if (/(mot de passe|password|nenosiri)/.test(m)) return 'PASSWORD';
    if (/\b\d{6}\b/.test(m) && /(code|otp|msimbo)/.test(m)) return 'OTP';
    return 'NOTIFICATION';
  }

  /** Version du message sans secret : codes à 6 chiffres masqués, mots de passe retirés. */
  private maskMessage(message: string, kind: SmsKind): string {
    if (kind === 'PASSWORD') return '[contenu masqué : contient un mot de passe]';
    return message.replace(/\b\d{6}\b/g, '******');
  }

  private async logSms(entry: {
    phone: string;
    message: string;
    success: boolean;
    providerMessageId?: string | null;
    error?: string | null;
  }) {
    if (!this.logEnabled) return;
    try {
      const kind = this.detectKind(entry.message);
      await writeAudit(getSharedPrisma(), {
        data: {
          action: entry.success ? 'SMS_SENT' : 'SMS_FAILED',
          entity: 'SMS',
          entityId: entry.phone.slice(0, 36),
          level: entry.success ? 'INFO' : 'ERROR',
          message: JSON.stringify({
            kind,
            sender: this.sender,
            length: entry.message.length,
            preview: this.maskMessage(entry.message, kind),
            providerMessageId: entry.providerMessageId || null,
            error: entry.error || null,
          }),
        },
      });
    } catch (err) {
      console.error('⚠️ Journalisation SMS impossible:', err?.message || err);
    }
  }

  // ─────────────────────────── envoi ───────────────────────────

  async sendSms(phoneNumber: string, message: string): Promise<boolean> {
    // ✅ Normalisation unique (libs/common/src/utils/phone.util.ts) :
    //    0979…, 979…, 243…, +243…, 00243…, +243 0979…, « 0979… / 0812… »
    //    → 243979649404 ; numéros vides, factices ou non mobiles refusés
    const check = checkSmsNumber(phoneNumber);
    let cleanPhone = check.number || check.international.replace('+', '') || String(phoneNumber || '').replace(/[^0-9]/g, '');

    try {
      if (!check.ok) {
        console.error(`❌ SMS non envoyé : ${check.reason}`);
        void this.logSms({ phone: cleanPhone || 'inconnu', message, success: false, error: check.reason });
        return false;
      }
      cleanPhone = check.number;

      // Construire l'URL
      const url = `${this.apiUrl}?api_id=${this.apiId}&api_password=${this.apiPassword}&sms_type=T&encoding=T&sender_id=${this.sender}&phonenumber=${cleanPhone}&textmessage=${encodeURIComponent(message)}`;

      // ✅ Les logs ne contiennent ni le mot de passe API, ni le contenu (OTP, mot de passe…)
      console.log(
        `📤 Envoi SMS à ${maskPhone(cleanPhone)} (${message.length} caractères, ${this.detectKind(message)})`,
      );

      const response = await axios.get<SmsResponse>(url, {
        timeout: 30000,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      });

      const data = response.data;
      if (data && data.status === 'S') {
        console.log(
          `✅ SMS envoyé avec succès! ID: ${data.message_id || 'N/A'}`,
        );
        void this.logSms({
          phone: cleanPhone, message, success: true, providerMessageId: data.message_id || null,
        });
        return true;
      } else {
        console.error('❌ Échec envoi SMS:', data);
        void this.logSms({
          phone: cleanPhone, message, success: false,
          error: String(data?.message || data?.status || 'Réponse inattendue du fournisseur').slice(0, 300),
        });
        return false;
      }
    } catch (error) {
      console.error("❌ Erreur lors de l'envoi SMS:", error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Data:', error.response.data);
      }
      void this.logSms({
        phone: cleanPhone, message, success: false, error: String(error?.message || error).slice(0, 300),
      });
      return false;
    }
  }

  async sendOtpSms(phoneNumber: string, otpCode: string): Promise<boolean> {
    const message = `Votre code de vérification AccesFinance est : ${otpCode}. Valable 10 minutes.`;
    return this.sendSms(phoneNumber, message);
  }

  async sendWelcomeSms(
    phoneNumber: string,
    fullName: string,
    accountNumber: string,
  ): Promise<boolean> {
    const message = `Bienvenue sur AccesFinance, ${fullName} ! Votre compte ${accountNumber} a été créé avec succès.`;
    return this.sendSms(phoneNumber, message);
  }
}
