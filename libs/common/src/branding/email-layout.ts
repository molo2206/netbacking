// libs/common/src/branding/email-layout.ts
import { BRAND, escapeHtml } from './brand';

/**
 * ═══════════════════════════════════════════════════════════════════
 * GABARIT EMAIL ACCESFINANCE
 * ═══════════════════════════════════════════════════════════════════
 * - HTML en tableaux (compatible Gmail, Outlook, Apple Mail…)
 * - Logo joint en pièce intégrée (cid:accesfinance-logo) : les images en
 *   base64 sont bloquées par Gmail, une URL externe peut ne pas s'afficher.
 * - Aucune ombre, couleurs de la charte AccesFinance.
 */

export const EMAIL_LOGO_CID = 'accesfinance-logo';

export interface EmailContent {
  lang?: string;
  title: string;
  preheader?: string;
  greeting?: string;
  paragraphs?: string[];
  /** Bloc mis en avant : code OTP, mot de passe temporaire… */
  highlight?: { label?: string; value: string; monospace?: boolean };
  /** Tableau de détails (libellé / valeur) */
  details?: Array<{ label: string; value: any }>;
  /** Paragraphes après le bloc principal */
  afterParagraphs?: string[];
  signature?: string;
  footerNote?: string;
  recipientEmail?: string;
  sentToLabel?: string;
}

export function renderEmail(c: EmailContent): string {
  const color = BRAND.colors;
  const p = (text: string) =>
    `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:${color.text};">${escapeHtml(text)}</p>`;

  const highlight = c.highlight
    ? `
      <tr><td style="padding:8px 0 22px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${color.primaryLight};border:1px solid #C9DCF5;border-radius:10px;">
          <tr><td align="center" style="padding:20px;">
            ${c.highlight.label ? `<div style="font-size:13px;color:${color.muted};margin-bottom:8px;">${escapeHtml(c.highlight.label)}</div>` : ''}
            <div style="font-size:${c.highlight.monospace === false ? '22px' : '32px'};font-weight:700;letter-spacing:${c.highlight.monospace === false ? '1px' : '8px'};color:${color.primary};font-family:${c.highlight.monospace === false ? 'Arial,Helvetica,sans-serif' : "'Courier New',monospace"};">${escapeHtml(c.highlight.value)}</div>
          </td></tr>
        </table>
      </td></tr>`
    : '';

  const details = c.details?.length
    ? `
      <tr><td style="padding:4px 0 20px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${color.border};border-radius:10px;">
          ${c.details
            .map(
              (d, i) => `
            <tr>
              <td style="padding:11px 16px;font-size:14px;color:${color.muted};${i ? `border-top:1px solid ${color.border};` : ''}">${escapeHtml(d.label)}</td>
              <td align="right" style="padding:11px 16px;font-size:14px;font-weight:600;color:${color.text};${i ? `border-top:1px solid ${color.border};` : ''}">${escapeHtml(d.value)}</td>
            </tr>`,
            )
            .join('')}
        </table>
      </td></tr>`
    : '';

  const contact = [BRAND.address, BRAND.phone, BRAND.email].filter(Boolean).map(escapeHtml).join(' · ');
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="${escapeHtml(c.lang || 'fr')}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(c.title)}</title>
</head>
<body style="margin:0;padding:0;background:${color.background};font-family:Arial,Helvetica,sans-serif;">
  ${c.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(c.preheader)}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${color.background};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border:1px solid ${color.border};border-radius:12px;">
        <!-- En-tête : logo -->
        <tr><td align="center" style="padding:26px 24px 18px 24px;border-bottom:3px solid ${color.primary};">
          <img src="cid:${EMAIL_LOGO_CID}" width="240" alt="${escapeHtml(BRAND.displayName)}" style="display:block;width:240px;max-width:80%;height:auto;border:0;" />
        </td></tr>
        <!-- Titre -->
        <tr><td style="padding:26px 32px 6px 32px;">
          <h1 style="margin:0;font-size:21px;line-height:1.3;color:${color.primary};">${escapeHtml(c.title)}</h1>
        </td></tr>
        <!-- Contenu -->
        <tr><td style="padding:16px 32px 8px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td>
              ${c.greeting ? `<p style="margin:0 0 14px 0;font-size:15px;font-weight:700;color:${color.text};">${escapeHtml(c.greeting)}</p>` : ''}
              ${(c.paragraphs || []).map(p).join('')}
            </td></tr>
            ${highlight}
            ${details}
            <tr><td>
              ${(c.afterParagraphs || []).map(p).join('')}
              ${c.signature ? `<p style="margin:18px 0 0 0;font-size:15px;color:${color.text};">${escapeHtml(c.signature).replace(/\n/g, '<br />')}</p>` : ''}
            </td></tr>
          </table>
        </td></tr>
        <!-- Pied de page -->
        <tr><td style="padding:22px 32px 26px 32px;border-top:1px solid ${color.border};background:#F8FAFD;border-radius:0 0 12px 12px;">
          ${c.footerNote ? `<p style="margin:0 0 8px 0;font-size:12px;color:${color.muted};">${escapeHtml(c.footerNote)}</p>` : ''}
          ${c.recipientEmail ? `<p style="margin:0 0 8px 0;font-size:12px;color:${color.muted};">${escapeHtml(c.sentToLabel || 'Cet email a été envoyé à')} ${escapeHtml(c.recipientEmail)}</p>` : ''}
          ${contact ? `<p style="margin:0 0 8px 0;font-size:12px;color:${color.muted};">${contact}</p>` : ''}
          <p style="margin:0;font-size:12px;color:${color.muted};">© ${year} ${escapeHtml(BRAND.displayName)} — ${escapeHtml(BRAND.tagline)}${BRAND.website ? ` · <a href="${escapeHtml(BRAND.website)}" style="color:${color.primary};text-decoration:none;">${escapeHtml(BRAND.website.replace(/^https?:\/\//, ''))}</a>` : ''}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
