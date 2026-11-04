// libs/common/src/branding/brand.ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * ═══════════════════════════════════════════════════════════════════
 * CHARTE ACCESFINANCE — utilisée par les emails, le relevé PDF, les SMS…
 * ═══════════════════════════════════════════════════════════════════
 * Les coordonnées se règlent dans le .env (COMPANY_*). Une valeur vide
 * n'est simplement pas affichée.
 */
export const BRAND = {
  name: 'AccesFinance',
  displayName: 'Accès Finance',
  tagline: 'Votre partenaire financier fiable',
  colors: {
    primary: '#0260C2',
    primaryDark: '#014A96',
    primaryLight: '#E8F0FB',
    text: '#1F2937',
    muted: '#6B7280',
    border: '#E5E7EB',
    background: '#F4F7FC',
    credit: '#16A34A',
    debit: '#DC2626',
  },
  get website(): string {
    return process.env.COMPANY_WEBSITE || 'https://accesfinance.africa';
  },
  get email(): string {
    return process.env.COMPANY_EMAIL || '';
  },
  get phone(): string {
    return process.env.COMPANY_PHONE || '';
  },
  get address(): string {
    return process.env.COMPANY_ADDRESS || 'Goma, République Démocratique du Congo';
  },
};

export type LogoVariant = 'full' | 'email' | 'pdf' | 'icon';

const LOGO_FILES: Record<LogoVariant, string> = {
  full: 'accesfinance-logo-white.png',
  email: 'accesfinance-logo-email.png',
  pdf: 'accesfinance-logo-pdf.png',
  icon: 'accesfinance-icon.png',
};

/** Cherche le fichier du logo (projet en dev, dist en production…). */
export function getLogoPath(variant: LogoVariant = 'full'): string | null {
  const file = LOGO_FILES[variant];
  const candidates = [
    process.env.BRAND_ASSETS_DIR ? path.join(process.env.BRAND_ASSETS_DIR, file) : null,
    path.join(process.cwd(), 'public', 'brand', file),
    path.join(process.cwd(), 'dist', 'public', 'brand', file),
    path.join(__dirname, '..', '..', '..', 'public', 'brand', file),
    path.join(__dirname, 'public', 'brand', file),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const base64Cache = new Map<LogoVariant, string>();

/** Logo en data-URI (pour le relevé PDF). Chaîne vide si introuvable. */
export function getLogoDataUri(variant: LogoVariant = 'pdf'): string {
  if (base64Cache.has(variant)) return base64Cache.get(variant)!;
  const p = getLogoPath(variant);
  if (!p) return '';
  try {
    const uri = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
    base64Cache.set(variant, uri);
    return uri;
  } catch {
    return '';
  }
}

/** Échappe une valeur avant de l'insérer dans du HTML. */
export function escapeHtml(value: any): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
