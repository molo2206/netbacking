// apps/auth-service/src/sms/sms.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { getSharedPrisma } from '../../../../libs/common/src/db/shared-prisma';

interface SmsResponse {
  status: string;
  message_id?: string;
  message?: string;
  [key: string]: any;
}

type SmsKind = 'OTP' | 'PASSWORD' | 'NOTIFICATION';

@Injectable()
export class SmsService {
  // ✅ Fournisseur Dream Digital — configurable via DREAM_SMS_* dans le .env
  //    (⚠️ ne PAS utiliser SMS_API_URL / SMS_SENDER : ce sont des valeurs d'exemple
  //     d'un autre fournisseur déjà présentes dans le .env)
  private readonly apiId = process.env.DREAM_SMS_API_ID || 'API42928758643';
  private readonly apiPassword = process.env.DREAM_SMS_API_PASSWORD || '@@Accesfina!2026';
  // ⚠️ Sender ID SMS : 11 caractères max et doit être enregistré chez le fournisseur.
  //    "AccesFinance" fait 12 caractères.
  private readonly sender = process.env.DREAM_SMS_SENDER || 'AccesPay';
  private readonly apiUrl = process.env.DREAM_SMS_API_URL || 'https://api2.dream-digital.info/api/SendSMS';
  // Journal des SMS dans audit_logs (entity = SMS) — consultable par l'admin
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
      await getSharedPrisma().auditLog.create({
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
    let cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '');

    try {
      // S'assurer que le numéro commence par 243
      if (!cleanPhone.startsWith('243')) {
        if (cleanPhone.startsWith('0')) {
          cleanPhone = `243${cleanPhone.substring(1)}`;
        } else {
          cleanPhone = `243${cleanPhone}`;
        }
      }

      // S'assurer que le numéro fait exactement 12 chiffres
      if (cleanPhone.length !== 12) {
        console.error(
          `❌ Numéro invalide: ${cleanPhone} (doit faire 12 chiffres)`,
        );
        void this.logSms({ phone: cleanPhone, message, success: false, error: 'Numéro invalide' });
        return false;
      }

      // Construire l'URL
      const url = `${this.apiUrl}?api_id=${this.apiId}&api_password=${this.apiPassword}&sms_type=T&encoding=T&sender_id=${this.sender}&phonenumber=${cleanPhone}&textmessage=${encodeURIComponent(message)}`;

      // ✅ Les logs ne contiennent ni le mot de passe API, ni le contenu (OTP, mot de passe…)
      console.log(
        `📤 Envoi SMS à ${cleanPhone} (${message.length} caractères, ${this.detectKind(message)})`,
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
