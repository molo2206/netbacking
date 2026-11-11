// libs/common/src/context/request-context.ts
/**
 * ═══════════════════════════════════════════════════════════════════
 * CONTEXTE DE LA REQUÊTE : qui, depuis quel appareil, quelle plateforme
 * ═══════════════════════════════════════════════════════════════════
 *  1. L'API Gateway construit le contexte de chaque requête HTTP
 *     (IP réelle, user-agent, appareil, navigateur, OS, plateforme…).
 *  2. Il est joint à chaque message RabbitMQ dans le champ `__ctx`.
 *  3. Chaque microservice le retire du message (RequestContextInterceptor)
 *     et le rend disponible pendant tout le traitement (AsyncLocalStorage).
 *  4. writeAudit() l'ajoute automatiquement à chaque ligne de audit_logs.
 *
 * Aucun handler existant n'a besoin d'être modifié : le champ `__ctx`
 * est retiré avant d'arriver au handler.
 * ═══════════════════════════════════════════════════════════════════
 */
import { AsyncLocalStorage } from 'async_hooks';

export const REQUEST_CONTEXT_FIELD = '__ctx';

export type DeviceType = 'MOBILE' | 'TABLET' | 'DESKTOP' | 'MOBILE_APP' | 'API_CLIENT' | 'UNKNOWN';

export interface DeviceInfo {
  deviceType: DeviceType;
  deviceName: string | null;   // « Samsung SM-A515F », « iPhone », « Windows PC »…
  os: string | null;           // « Android 13 », « iOS 17.1 », « Windows 10/11 »…
  browser: string | null;      // « Chrome 120 », « Safari 17 », « Application mobile »…
  deviceId: string | null;     // identifiant envoyé par l'app (x-device-id / deviceId)
  appVersion: string | null;   // x-app-version
}

export interface RequestContext extends DeviceInfo {
  ipAddress: string | null;
  userAgent: string | null;
  origin: string | null;
  /** x-client, sinon déduit de l'origine (net-admin → BACK_OFFICE, net-banking → WEB) */
  client: string | null;
  /** Champ platform du body s'il existe */
  declaredPlatform: string | null;
  /** Jeton d'accès (pour retrouver la plateforme de la session) — jamais journalisé */
  token: string | null;
  /** Plateforme déjà résolue : MOBILE / WEB / BACK_OFFICE / UNKNOWN */
  platform: string | null;
  /** Utilisateur authentifié (renseigné par JwtAuthGuard) */
  userId: string | null;
  userRole: string | null;
}

const storage = new AsyncLocalStorage<Partial<RequestContext>>();

export function runWithRequestContext<T>(ctx: Partial<RequestContext>, fn: () => T): T {
  return storage.run(ctx || {}, fn);
}

export function getRequestContext(): Partial<RequestContext> {
  return storage.getStore() || {};
}

/** Contexte transmissible dans un message RabbitMQ (sans le jeton complet). */
export function serializableContext(ctx: Partial<RequestContext> = getRequestContext()): Partial<RequestContext> {
  const out: Partial<RequestContext> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined && v !== null && v !== '') (out as any)[k] = v;
  }
  return out;
}

// ─────────────────────────── appareil ───────────────────────────

const ANDROID_BRANDS: Array<[RegExp, string]> = [
  [/^SM-|^GT-|^SAMSUNG/i, 'Samsung'],
  [/^Infinix/i, 'Infinix'],
  [/^TECNO|^Tecno/i, 'Tecno'],
  [/^itel/i, 'itel'],
  [/^Redmi|^M\d{4}|^2\d{3}[A-Z0-9]{4,}|^Mi /i, 'Xiaomi'],
  [/^Pixel/i, 'Google'],
  [/^CPH|^OPPO/i, 'Oppo'],
  [/^vivo|^V\d{4}/i, 'Vivo'],
  [/^RMX/i, 'Realme'],
  [/^moto|^Moto/i, 'Motorola'],
  [/^Nokia/i, 'Nokia'],
  [/^HUAWEI|^[A-Z]{3}-L\d{2}/i, 'Huawei'],
];

function androidModel(ua: string): string | null {
  const m = /Android [\d.]+;\s*(?:[a-z]{2}[-_][a-z]{2};\s*)?([^;)]+?)(?:\s+Build\/|\)|;)/i.exec(ua);
  if (!m) return null;
  const model = m[1].trim();
  if (!model || /^(K|wv|Mobile|Linux)$/i.test(model)) return null;
  const brand = ANDROID_BRANDS.find(([re]) => re.test(model))?.[1];
  return brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${model}` : model;
}

function clean(v: any, max = 120): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\r\n\t]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Lit le user-agent (et les headers envoyés par les apps) pour décrire l'appareil.
 * Headers facultatifs reconnus : x-device-id, x-device-name (ou x-device-model),
 * x-os (ou x-os-name), x-os-version, x-app-version.
 */
export function parseDevice(userAgent?: string | null, hints: Record<string, any> = {}): DeviceInfo {
  const ua = String(userAgent || '');
  const low = ua.toLowerCase();

  let deviceType: DeviceType = 'UNKNOWN';
  let deviceName: string | null = null;
  let os: string | null = null;
  let browser: string | null = null;

  // ── Système d'exploitation ──
  let m: RegExpExecArray | null;
  if ((m = /Android ([\d.]+)/i.exec(ua))) os = `Android ${m[1]}`;
  else if ((m = /(?:iPhone|CPU) OS ([\d_]+)/i.exec(ua))) os = `iOS ${m[1].replace(/_/g, '.')}`;
  else if (/iPad/i.test(ua)) os = 'iPadOS';
  else if ((m = /Windows NT ([\d.]+)/i.exec(ua))) {
    const map: Record<string, string> = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
    os = `Windows ${map[m[1]] || m[1]}`;
  } else if ((m = /Mac OS X ([\d_.]+)/i.exec(ua))) os = `macOS ${m[1].replace(/_/g, '.')}`;
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  else if ((m = /Darwin\/([\d.]+)/i.exec(ua))) os = 'iOS';
  else if (/okhttp|dalvik/i.test(ua)) os = 'Android';

  // ── Type d'appareil, navigateur, nom ──
  if (/okhttp|dalvik|react-native|expo|dart\//i.test(ua) || (/cfnetwork|darwin/i.test(ua) && !/mozilla/i.test(ua))) {
    deviceType = 'MOBILE_APP';
    browser = 'Application mobile';
    if ((m = /okhttp\/([\d.]+)/i.exec(ua))) browser = `Application mobile (okhttp ${m[1]})`;
    deviceName = /cfnetwork|darwin/i.test(ua) ? 'iPhone / iPad' : androidModel(ua) || 'Téléphone Android';
  } else if (/mozilla|opera/i.test(ua)) {
    if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) deviceType = 'TABLET';
    else if (/Mobi|iPhone|Android/i.test(ua)) deviceType = 'MOBILE';
    else deviceType = 'DESKTOP';

    if ((m = /Edg(?:e|A|iOS)?\/([\d]+)/.exec(ua))) browser = `Edge ${m[1]}`;
    else if ((m = /OPR\/([\d]+)/.exec(ua))) browser = `Opera ${m[1]}`;
    else if ((m = /SamsungBrowser\/([\d]+)/.exec(ua))) browser = `Samsung Internet ${m[1]}`;
    else if ((m = /(?:Firefox|FxiOS)\/([\d]+)/.exec(ua))) browser = `Firefox ${m[1]}`;
    else if ((m = /(?:Chrome|CriOS)\/([\d]+)/.exec(ua))) browser = `Chrome ${m[1]}`;
    else if ((m = /Version\/([\d.]+).*Safari/.exec(ua))) browser = `Safari ${m[1].split('.')[0]}`;
    else if (/Safari/.test(ua)) browser = 'Safari';

    if (/iPhone/.test(ua)) deviceName = 'iPhone';
    else if (/iPad/.test(ua)) deviceName = 'iPad';
    else if (/Android/i.test(ua)) deviceName = androidModel(ua) || (deviceType === 'TABLET' ? 'Tablette Android' : 'Téléphone Android');
    else if (/Windows/.test(ua)) deviceName = 'Ordinateur Windows';
    else if (/Macintosh/.test(ua)) deviceName = 'Mac';
    else if (/CrOS/.test(ua)) deviceName = 'Chromebook';
    else if (/Linux/.test(ua)) deviceName = 'Ordinateur Linux';
  } else if (/postman|insomnia|curl|wget|httpie|axios|node-fetch|python-requests|java\//i.test(low)) {
    deviceType = 'API_CLIENT';
    deviceName = 'Client API';
    browser = clean(ua.split(' ')[0], 60);
  }

  // ── Informations envoyées explicitement par l'app (prioritaires) ──
  const hintName = clean(hints.deviceName ?? hints['x-device-name'] ?? hints['x-device-model'], 100);
  const hintOs = clean(hints.os ?? hints['x-os'] ?? hints['x-os-name'], 40);
  const hintOsVersion = clean(hints.osVersion ?? hints['x-os-version'], 20);
  if (hintName) deviceName = hintName;
  if (hintOs) os = hintOsVersion ? `${hintOs} ${hintOsVersion}` : hintOs;
  else if (hintOsVersion && os && !/\d/.test(os)) os = `${os} ${hintOsVersion}`;

  return {
    deviceType,
    deviceName: clean(deviceName, 100),
    os: clean(os, 50),
    browser: clean(browser, 60),
    deviceId: clean(hints.deviceId ?? hints['x-device-id'], 255),
    appVersion: clean(hints.appVersion ?? hints['x-app-version'], 30),
  };
}

/** Résumé lisible : « Samsung SM-A515F · Android 13 · Application mobile ». */
export function describeDevice(d: Partial<DeviceInfo>): string {
  return [d.deviceName, d.os, d.browser].filter(Boolean).join(' · ') || 'Appareil inconnu';
}

// ─────────────────────────── origine → interface ───────────────────────────

function originList(envName: string, defaults: string[]): RegExp[] {
  const extra = String(process.env[envName] || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .map((o) => new RegExp('^' + o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
  return [...defaults.map((d) => new RegExp(d, 'i')), ...extra];
}

/**
 * Interface d'où vient la requête, déduite de l'origine du navigateur.
 *   ADMIN_APP_ORIGINS  : origines de l'administration (en plus des valeurs par défaut)
 *   CLIENT_APP_ORIGINS : origines du Net Banking (en plus des valeurs par défaut)
 */
export function clientFromOrigin(origin?: string | null): 'BACK_OFFICE' | 'WEB' | null {
  const o = String(origin || '').trim().replace(/\/$/, '');
  if (!o) return null;
  const admin = originList('ADMIN_APP_ORIGINS', [
    '^https://net-admin-drab(-[a-z0-9-]+)?\\.vercel\\.app$',
    '^https://(admin|backoffice|back-office)[a-z0-9.-]*\\.accesfinance\\.africa$',
  ]);
  if (admin.some((re) => re.test(o))) return 'BACK_OFFICE';
  const client = originList('CLIENT_APP_ORIGINS', [
    '^https://net-banking(-[a-z0-9-]+)?\\.vercel\\.app$',
    '^https://(www\\.)?(netbanking|net-banking)[a-z0-9.-]*\\.accesfinance\\.africa$',
  ]);
  if (client.some((re) => re.test(o))) return 'WEB';
  return null;
}

/**
 * Complète le contexte avec le body (lu après le parsing JSON) :
 * platform, deviceId, deviceName, appVersion envoyés par les apps.
 */
export function enrichContextFromBody(ctx: Partial<RequestContext>, body: any) {
  if (!ctx || !body || typeof body !== 'object' || Array.isArray(body)) return;
  if (!ctx.declaredPlatform && body.platform) ctx.declaredPlatform = clean(body.platform, 30);
  if (!ctx.deviceId && body.deviceId) ctx.deviceId = clean(body.deviceId, 255);
  if (body.deviceName && (!ctx.deviceName || /^Téléphone|^Application|^iPhone \/ iPad$/.test(ctx.deviceName))) {
    ctx.deviceName = clean(body.deviceName, 100);
  }
  if (!ctx.appVersion && body.appVersion) ctx.appVersion = clean(body.appVersion, 30);
}

/** Construit le contexte à partir d'une requête Express (API Gateway). */
export function buildRequestContext(req: any): Partial<RequestContext> {
  const h = (name: string): string | null => {
    const v = req?.headers?.[name];
    return clean(Array.isArray(v) ? v[0] : v, 500);
  };
  // req.ip tient compte de X-Forwarded-For uniquement quand la requête vient du
  // reverse proxy local (Apache) : 'trust proxy' = 'loopback' dans main.ts
  const ipAddress = clean(req?.ip || req?.socket?.remoteAddress, 45);
  const userAgent = h('user-agent');
  const origin = h('origin') || (h('referer') ? (/^(https?:\/\/[^/]+)/i.exec(h('referer') as string)?.[1] ?? null) : null);
  const body = req?.body && typeof req.body === 'object' ? req.body : {};

  const device = parseDevice(userAgent, {
    deviceId: h('x-device-id') || body.deviceId || null,
    deviceName: h('x-device-name') || h('x-device-model') || body.deviceName || null,
    os: h('x-os') || h('x-os-name') || null,
    osVersion: h('x-os-version') || null,
    appVersion: h('x-app-version') || body.appVersion || null,
  });

  const auth = h('authorization');
  return {
    ...device,
    ipAddress: ipAddress ? ipAddress.replace(/^::ffff:/, '') : null,
    userAgent,
    origin,
    client: h('x-client') || h('x-platform') || clientFromOrigin(origin),
    declaredPlatform: clean(body.platform, 30),
    token: auth ? auth.replace(/^Bearer\s+/i, '').trim() : null,
    platform: null,
  };
}
