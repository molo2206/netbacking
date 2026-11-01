// apps/transaction-service/src/bank/encryption.service.ts
import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;
  private readonly iv: Buffer;

  constructor() {
    const keyString = process.env.BANK_ENCRYPTION_KEY || '';
    const ivString = process.env.BANK_IV || '';

    if (!keyString) throw new Error('BANK_ENCRYPTION_KEY manquante dans la configuration');
    if (!ivString) throw new Error('BANK_IV manquant dans la configuration');

    this.key = Buffer.from(keyString, 'utf8');
    this.iv = Buffer.from(ivString, 'utf8');

    if (this.key.length !== 32) {
      throw new Error(
        `BANK_ENCRYPTION_KEY doit faire 32 octets (AES-256), reçu ${this.key.length} octets`,
      );
    }
    if (this.iv.length !== 16) {
      throw new Error(`BANK_IV doit faire 16 octets (AES-CBC), reçu ${this.iv.length} octets`);
    }

    this.logger.log('EncryptionService initialisé (aes-256-cbc)');
  }

  encrypt(plainText: string): string {
    const cipher = crypto.createCipheriv('aes-256-cbc', this.key, this.iv);
    let encrypted = cipher.update(plainText, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

  decrypt(encryptedText: string): string {
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.key, this.iv);
    let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  decryptResponse(encryptedResponse: string): any {
    try {
      const decrypted = this.decrypt(encryptedResponse);
      let parsed: any = JSON.parse(decrypted);

      // ✅ Si la banque a chiffré une chaîne JSON (double-encodage), on re-parse
      if (typeof parsed === 'string') {
        try {
          const reparsed = JSON.parse(parsed);
          this.logger.log('Double JSON détecté dans decryptResponse — re-parsing');
          parsed = reparsed;
        } catch {
          /* garde la chaîne si non re-parsable */
        }
      }

      return parsed;
    } catch (error) {
      this.logger.error(
        `Échec du déchiffrement de la réponse banque: ${error.message}`,
      );
      throw new Error(
        `Impossible de déchiffrer la réponse banque: ${error.message}`,
      );
    }
  }

  encryptRequest(payload: any): string {
    const jsonString = JSON.stringify(payload);
    return this.encrypt(jsonString);
  }
}