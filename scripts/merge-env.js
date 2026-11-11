#!/usr/bin/env node
/**
 * Construit le .env opérationnel d'AccesFinance.
 *
 *   node scripts/merge-env.js            → écrit .env (ancien .env sauvegardé)
 *   node scripts/merge-env.js --check    → affiche seulement ce qui manque, n'écrit rien
 *
 * Règles :
 *  - modèle : .env.accesfinance (toutes les variables du projet, commentées)
 *  - une valeur NON VIDE déjà présente dans ton .env actuel est TOUJOURS conservée
 *    (clés de la banque, secrets JWT, mot de passe de la base…)
 *  - les variables absentes ou vides de ton .env sont prises dans le modèle
 *  - les variables de ton .env qui ne sont pas dans le modèle sont gardées à la fin
 *  - l'ancien .env est copié en .env.backup-AAAAMMJJ-HHMMSS
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const templatePath = path.join(root, '.env.accesfinance');
const envPath = path.join(root, '.env');
const checkOnly = process.argv.includes('--check');

function parse(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

const isEmpty = (raw) => raw === undefined || raw === '' || raw === '""' || raw === "''";

if (!fs.existsSync(templatePath)) {
  console.error('❌ Modèle introuvable : .env.accesfinance');
  process.exit(1);
}
const templateText = fs.readFileSync(templatePath, 'utf8');
const current = fs.existsSync(envPath) ? parse(fs.readFileSync(envPath, 'utf8')) : new Map();
const templateKeys = new Set(parse(templateText).keys());

const kept = [];
const added = [];
const stillEmpty = [];

const out = templateText.split(/\r?\n/).map((line) => {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  if (!m) return line;
  const key = m[1];
  const templateValue = m[2].trim();
  const currentValue = current.get(key);
  if (!isEmpty(currentValue)) {
    kept.push(key);
    return `${key}=${currentValue}`;
  }
  if (isEmpty(templateValue)) stillEmpty.push(key);
  else added.push(key);
  return `${key}=${templateValue}`;
});

const extras = [...current.keys()].filter((k) => !templateKeys.has(k));
if (extras.length) {
  out.push('', '# ==================== VARIABLES DE L\'ANCIEN .env (conservées) ====================');
  for (const k of extras) out.push(`${k}=${current.get(k)}`);
}

// Variables indispensables au démarrage
const required = ['DATABASE_URL', 'RABBITMQ_URL', 'JWT_SECRET', 'BANK_ENCRYPTION_KEY', 'BANK_IV'];
const finalMap = parse(out.join('\n'));
const missingRequired = required.filter((k) => isEmpty(finalMap.get(k)));
const unquote = (v) => String(v || '').replace(/^["']|["']$/g, '');
const lengthIssues = [];
if (!isEmpty(finalMap.get('BANK_ENCRYPTION_KEY')) && Buffer.byteLength(unquote(finalMap.get('BANK_ENCRYPTION_KEY'))) !== 32) {
  lengthIssues.push('BANK_ENCRYPTION_KEY doit faire 32 caractères');
}
if (!isEmpty(finalMap.get('BANK_IV')) && Buffer.byteLength(unquote(finalMap.get('BANK_IV'))) !== 16) {
  lengthIssues.push('BANK_IV doit faire 16 caractères');
}

console.log(`✅ Conservées depuis ton .env : ${kept.length}`);
console.log(`➕ Ajoutées depuis le modèle   : ${added.length}${added.length ? ' (' + added.join(', ') + ')' : ''}`);
if (extras.length) console.log(`📦 Variables propres à ton .env gardées : ${extras.join(', ')}`);
if (stillEmpty.length) console.log(`ℹ️  Vides (facultatives) : ${stillEmpty.join(', ')}`);
if (missingRequired.length) console.log(`⚠️  À RENSEIGNER avant de démarrer : ${missingRequired.join(', ')}`);
for (const issue of lengthIssues) console.log(`⚠️  ${issue}`);

if (checkOnly) {
  console.log('\n(--check : aucun fichier modifié)');
  process.exit(missingRequired.length || lengthIssues.length ? 2 : 0);
}

if (fs.existsSync(envPath)) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-` +
    `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const backup = path.join(root, `.env.backup-${stamp}`);
  fs.copyFileSync(envPath, backup);
  console.log(`💾 Ancien .env sauvegardé : ${path.basename(backup)}`);
}
fs.writeFileSync(envPath, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
console.log('📝 .env écrit.');
process.exit(missingRequired.length || lengthIssues.length ? 2 : 0);
