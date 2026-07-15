// libs/common/src/i18n/i18n.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class I18nService {
  private readonly logger = new Logger(I18nService.name);
  private translations: Map<string, Map<string, string>> = new Map();
  private defaultLanguage: string = 'fr';

  constructor() {
    this.loadTranslations();
  }

  private loadTranslations() {
    const languages = ['fr', 'en', 'sw'];
    
    // Recherche du chemin des locales
    let basePath = this.findLocalesPath();
    
    if (!basePath) {
      this.logger.error('❌ Locales directory not found!');
      return;
    }

    this.logger.log(`📂 Loading translations from: ${basePath}`);

    for (const lang of languages) {
      const langMap = new Map<string, string>();
      const langDir = path.join(basePath, lang);
      
      if (fs.existsSync(langDir)) {
        const files = fs.readdirSync(langDir);
        let totalKeys = 0;
        
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = path.join(langDir, file);
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              const json = JSON.parse(content);
              for (const [key, value] of Object.entries(json)) {
                langMap.set(key, value as string);
              }
              totalKeys += Object.keys(json).length;
            } catch (err) {
              this.logger.error(`Error parsing ${filePath}: ${err.message}`);
            }
          }
        }
        this.logger.log(`✅ Loaded ${totalKeys} keys for language: ${lang}`);
      } else {
        this.logger.warn(`⚠️ Language directory not found: ${langDir}`);
      }
      this.translations.set(lang, langMap);
    }

    this.logger.log(`📚 Available languages: ${Array.from(this.translations.keys()).join(', ')}`);
  }

  private findLocalesPath(): string | null {
    const possiblePaths = [
      // En développement
      path.join(process.cwd(), 'libs', 'common', 'src', 'i18n', 'locales'),
      // En production
      path.join(process.cwd(), 'dist', 'libs', 'common', 'src', 'i18n', 'locales'),
      // Dans le dossier courant
      path.join(__dirname, 'locales'),
      path.join(__dirname, '..', 'locales'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  translate(key: string, lang: string = this.defaultLanguage, params?: Record<string, any>): string {
    const langMap = this.translations.get(lang);
    let text = langMap?.get(key) || this.translations.get(this.defaultLanguage)?.get(key) || key;
    
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`{{${k}}}`, 'g'), v);
        text = text.replace(new RegExp(`{${k}}`, 'g'), v);
      }
    }
    return text;
  }

  // Méthodes utilitaires
  getTranslations(lang: string = this.defaultLanguage): Record<string, string> {
    const langMap = this.translations.get(lang);
    if (!langMap) return {};
    return Object.fromEntries(langMap);
  }

  hasLanguage(lang: string): boolean {
    return this.translations.has(lang);
  }

  getAvailableLanguages(): string[] {
    return Array.from(this.translations.keys());
  }

  setDefaultLanguage(lang: string): void {
    if (this.hasLanguage(lang)) {
      this.defaultLanguage = lang;
      this.logger.log(`🌐 Default language set to: ${lang}`);
    }
  }

  getDefaultLanguage(): string {
    return this.defaultLanguage;
  }

  reloadTranslations(): void {
    this.loadTranslations();
  }
}