// libs/common/src/pdf/html-to-pdf.ts
import * as fs from 'fs';
import * as puppeteer from 'puppeteer';

/**
 * Conversion HTML → PDF (A4) avec puppeteer.
 *  - Navigateur : PUPPETEER_EXECUTABLE_PATH, sinon Chromium/Chrome du système,
 *    sinon le navigateur téléchargé par puppeteer.
 *  - Un seul PDF à la fois (le serveur a peu de RAM).
 *  - Numéro de page en pied de page.
 */

const SYSTEM_BROWSERS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

function resolveExecutable(): string | undefined {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return SYSTEM_BROWSERS.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

let queue: Promise<unknown> = Promise.resolve();

export async function htmlToPdf(
  html: string,
  options: { footerLabel?: string; ofLabel?: string } = {},
): Promise<Buffer> {
  const run = async (): Promise<Buffer> => {
    const executablePath = resolveExecutable();
    const browser = await puppeteer.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 120000 });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `<div style="width:100%;font-size:8px;color:#9ca3af;text-align:center;font-family:Arial,sans-serif;">
          ${options.footerLabel || 'Page'} <span class="pageNumber"></span> ${options.ofLabel || 'sur'} <span class="totalPages"></span>
        </div>`,
        margin: { top: '20px', bottom: '40px', left: '20px', right: '20px' },
        timeout: 120000,
      });
      const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      if (!buffer.length) throw new Error('PDF vide');
      return buffer;
    } finally {
      await browser.close().catch(() => undefined);
    }
  };

  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
