// apps/auth-service/src/email/email.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;
  private isConfigured: boolean = false;

  constructor(private configService: ConfigService) {
    this.configureTransporter();
  }

  private configureTransporter() {
    try {
      // ✅ Utiliser les bonnes variables d'environnement
      const smtpUser = this.configService.get('MAILER_USER');
      const smtpPassword = this.configService.get('MAILER_PASS');
      const smtpHost = this.configService.get('MAILER_HOST', 'smtp.gmail.com');
      const smtpPort = this.configService.get('MAILER_PORT', 587);
      const smtpSecure = this.configService.get('MAILER_SECURE', false);

      // ✅ Vérifier que les identifiants sont présents
      if (!smtpUser || !smtpPassword || smtpUser === '' || smtpPassword === '') {
        this.logger.warn('⚠️ SMTP credentials not configured. Email sending disabled.');
        this.isConfigured = false;
        this.transporter = nodemailer.createTransport({
          jsonTransport: true,
        });
        return;
      }

      this.logger.log(`📧 Configuring SMTP with ${smtpUser} at ${smtpHost}:${smtpPort}`);

      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure === 'true' || smtpPort === 465,
        auth: {
          user: smtpUser,
          pass: smtpPassword,
        },
        tls: {
          rejectUnauthorized: false,
        },
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 30000,
      });

      this.isConfigured = true;
      this.logger.log('✅ SMTP configured successfully');
      
      // Vérifier la connexion
      this.verifyConnection();
    } catch (error) {
      this.logger.error('❌ Failed to configure SMTP:', error.message);
      this.isConfigured = false;
    }
  }

  private async verifyConnection() {
    try {
      await this.transporter.verify();
      this.logger.log('✅ SMTP connection verified');
    } catch (error) {
      this.logger.error('❌ SMTP connection failed:', error.message);
      this.isConfigured = false;
    }
  }

  async sendHtmlEmail(
    to: string,
    subject: string,
    templateName: string,
    context: any = {},
  ): Promise<boolean> {
    if (!this.isConfigured) {
      this.logger.warn('⚠️ Email service not configured, skipping email send');
      return false;
    }

    try {
      if (!to || !to.includes('@')) {
        this.logger.warn(`⚠️ Invalid email address: ${to}`);
        return false;
      }

      const html = this.buildHtmlFromTemplate(templateName, context);

      // ✅ Utiliser MAILER_USER comme from par défaut
      const from = this.configService.get('MAILER_USER', 'noreply@netbacking.com');
      
      const mailOptions = {
        from: `AccesPay <${from}>`,
        to,
        subject,
        html,
      };

      await this.transporter.sendMail(mailOptions);
      this.logger.log(`✅ Email sent to ${to}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Failed to send email to ${to}:`, error.message);
      return false;
    }
  }

  async sendEmailWithAttachment(
    to: string,
    subject: string,
    htmlContent: string,
    attachment: {
      filename: string;
      content: Buffer;
      contentType: string;
    },
  ): Promise<boolean> {
    if (!this.isConfigured) {
      this.logger.warn('⚠️ Email service not configured, skipping email send');
      return false;
    }

    try {
      const from = this.configService.get('MAILER_USER', 'noreply@netbacking.com');
      
      const mailOptions = {
        from: `AccesPay <${from}>`,
        to,
        subject,
        html: htmlContent,
        attachments: [attachment],
      };

      await this.transporter.sendMail(mailOptions);
      this.logger.log(`✅ Email with attachment sent to ${to}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Failed to send email with attachment to ${to}:`, error);
      return false;
    }
  }

  private buildHtmlFromTemplate(template: string, context: any): string {
    if (template.includes('otp')) {
      return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #0066cc;">${context.title || 'Code de vérification'}</h1>
          <p>${context.greeting || 'Bonjour'},</p>
          <p>${context.message || 'Voici votre code de vérification'}</p>
          <div style="background: #f0f4ff; padding: 20px; text-align: center; font-size: 32px; letter-spacing: 5px; color: #0066cc; border-radius: 8px; margin: 20px 0;">
            <strong>${context.otpCode || ''}</strong>
          </div>
          <p>${context.expiry || 'Ce code expire dans 10 minutes'}</p>
          <p style="color: #666; font-size: 14px;">${context.ignore || 'Si vous n\'avez pas demandé ce code, ignorez cet email'}</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="color: #666; font-size: 14px;">${context.thanks || 'Merci'}</p>
          <p style="color: #666; font-size: 14px;">${context.team || 'L\'équipe'}</p>
          <p style="font-size: 12px; color: #999;">${context.footer || ''}</p>
          <p style="font-size: 12px; color: #999;">${context.copyright || ''}</p>
        </body>
        </html>
      `;
    }

    if (template.includes('welcome')) {
      return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #0066cc;">${context.title || 'Bienvenue'}</h1>
          <p>${context.greeting || 'Bonjour'},</p>
          <p>${context.message || 'Votre compte a été créé avec succès'}</p>
          <h3 style="color: #333;">${context.credentials_label || 'Vos identifiants'}</h3>
          <ul style="list-style: none; padding: 0;">
            <li style="padding: 8px 0; border-bottom: 1px solid #eee;"><strong>Téléphone:</strong> ${context.phone_label || ''}</li>
            <li style="padding: 8px 0; border-bottom: 1px solid #eee;"><strong>Numéro de compte:</strong> ${context.account_label || ''}</li>
            <li style="padding: 8px 0;"><strong>Mot de passe:</strong> ${context.password_label || ''}</li>
          </ul>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="font-size: 12px; color: #999;">${context.footer || ''}</p>
          <p style="font-size: 12px; color: #999;">${context.copyright || ''}</p>
        </body>
        </html>
      `;
    }

    return `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"></head>
      <body style="font-family: Arial, sans-serif;">
        <h1>${context.title || ''}</h1>
        <p>${context.message || ''}</p>
      </body>
      </html>
    `;
  }

  private readTemplateFile(templateName: string): string {
    try {
      const templatePath = path.join(process.cwd(), 'templates', 'auth', templateName);
      if (fs.existsSync(templatePath)) {
        return fs.readFileSync(templatePath, 'utf-8');
      }
      return '';
    } catch (error) {
      this.logger.error(`Failed to read template ${templateName}:`, error);
      return '';
    }
  }
}