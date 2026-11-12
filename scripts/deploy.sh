#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
# AccesFinance — installation / mise à jour complète sur le serveur
#   bash scripts/deploy.sh
# Étapes (chacune est sautée si déjà faite) :
#   1. vérifie Node, MySQL, RabbitMQ
#   2. .env : créé depuis .env.accesfinance s'il n'existe pas, sinon complété
#      (les valeurs existantes sont conservées, sauvegarde automatique)
#   3. Google Chrome (génération des relevés PDF)
#   4. dépendances npm (firebase-admin 13.8.0, compatible Node 20) + Prisma
#   5. colonnes de traçabilité en base (appareil / plateforme)
#   6. compilation des 4 services
#   7. (re)démarrage PM2 + sauvegarde
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ok()   { echo -e "\e[32m✔ $*\e[0m"; }
warn() { echo -e "\e[33m⚠ $*\e[0m"; }
step() { echo -e "\n\e[1m═══ $* ═══\e[0m"; }

step "1. Prérequis"
command -v node >/dev/null || { echo "Node.js absent : curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"; exit 1; }
ok "Node $(node -v)"
command -v pm2 >/dev/null || npm install -g pm2
for svc in mysql rabbitmq-server; do
  if systemctl is-active --quiet "$svc"; then ok "$svc actif"; else
    warn "$svc inactif : démarrage"; systemctl enable --now "$svc" || { echo "Impossible de démarrer $svc"; exit 1; }
  fi
done

step "2. Fichier .env"
if [ ! -f .env ]; then
  cp .env.accesfinance .env && chmod 600 .env && ok ".env créé depuis .env.accesfinance"
else
  node scripts/merge-env.js || true
fi
check_out="$(node scripts/merge-env.js --check 2>&1 || true)"
if echo "$check_out" | grep -qE "À RENSEIGNER|doit faire"; then
  echo "$check_out" | grep -E "À RENSEIGNER|doit faire"; warn "Corrige le .env puis relance le script"; exit 1
fi
ok ".env complet"

step "3. Navigateur pour les relevés PDF"
if [ -x /usr/bin/google-chrome-stable ]; then ok "$(google-chrome-stable --version)"; else
  tmp="$(mktemp -d)"
  wget -q -O "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y "$tmp/chrome.deb" fonts-liberation fonts-dejavu-core >/dev/null
  rm -rf "$tmp"; ok "Google Chrome installé : $(google-chrome-stable --version)"
fi

step "4. Dépendances + Prisma"
npm install --include=dev --no-audit --no-fund
installed_fb="$(node -p "require('firebase-admin/package.json').version" 2>/dev/null || echo none)"
if [[ "$installed_fb" != 13.* ]]; then npm install firebase-admin@13.8.0 --no-audit --no-fund; fi
ok "firebase-admin $(node -p "require('firebase-admin/package.json').version")"
npx prisma generate >/dev/null && ok "Client Prisma généré"

step "5. Mises à jour de la base (traçabilité, suppression définitive, OTP Web)"
DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"')"
if [[ "$DB_URL" =~ mysql://([^:]+):([^@]+)@([^:/]+):?([0-9]*)/([^?]+) ]]; then
  MYSQL_PWD="${BASH_REMATCH[2]}" mysql -u "${BASH_REMATCH[1]}" -h "${BASH_REMATCH[3]}" -P "${BASH_REMATCH[4]:-3306}" --force "${BASH_REMATCH[5]}" \
    < prisma/sql/20261111_device_tracking.sql 2>&1 | grep -v "Duplicate column\|Duplicate key name" || true
  MYSQL_PWD="${BASH_REMATCH[2]}" mysql -u "${BASH_REMATCH[1]}" -h "${BASH_REMATCH[3]}" -P "${BASH_REMATCH[4]:-3306}" --force "${BASH_REMATCH[5]}" \
    < prisma/sql/20261112_user_deletion_and_login_otp.sql 2>&1 | grep -v "Duplicate\|Can't DROP\|check that column/key exists\|already exists" || true
  ok "Colonnes vérifiées (les services les ajoutent aussi au démarrage)"
else
  warn "DATABASE_URL illisible : les services ajouteront les colonnes au démarrage"
fi

step "6. Compilation"
for app in api-gateway auth-service user-service transaction-service; do
  npm run build "$app" >/tmp/build-$app.log 2>&1 && ok "$app compilé" || { echo "❌ Échec de compilation $app :"; tail -40 /tmp/build-$app.log; exit 1; }
done

step "7. Démarrage PM2"
pm2 delete netbacking-audit >/dev/null 2>&1 || true
pm2 startOrReload ecosystem.config.js --update-env
sleep 15
pm2 status
pm2 save >/dev/null && ok "Configuration PM2 sauvegardée"

echo
pm2 logs --lines 80 --nostream 2>/dev/null | grep -E "EncryptionService|Firebase|SMTP|Push désactivé|manquante|Colonne ajoutée" | tail -12 || true
echo
curl -s -m 10 http://localhost:3000/health && echo && ok "API opérationnelle" || warn "L'API ne répond pas encore : pm2 logs --err --lines 30"
