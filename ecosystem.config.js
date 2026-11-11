// ecosystem.config.js — démarrage PM2 des services AccesFinance
// Utilisation :
//   pm2 start ecosystem.config.js        (première fois)
//   pm2 restart ecosystem.config.js --update-env   (après un build)
//   pm2 save                              (redémarrage automatique au boot)

const common = {
  cwd: __dirname, // le .env du projet est lu depuis ce dossier
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  max_restarts: 10,          // évite les boucles infinies si un service plante au démarrage
  min_uptime: '20s',
  restart_delay: 5000,
  max_memory_restart: '600M',
  env: {
    NODE_ENV: 'production',
    // Navigateur utilisé pour générer les relevés PDF (installé par scripts/deploy.sh)
    PUPPETEER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
    DATABASE_URL: 'mysql://admin:admin2025@localhost:3306/netbacking_db',
  },
};

module.exports = {
  apps: [
    { ...common, name: 'netbacking-gateway', script: 'dist/apps/api-gateway/main.js', env: { ...common.env, port: 3000 } },
    { ...common, name: 'netbacking-auth', script: 'dist/apps/auth-service/main.js' },
    { ...common, name: 'netbacking-user', script: 'dist/apps/user-service/main.js' },
    { ...common, name: 'netbacking-transaction', script: 'dist/apps/transaction-service/main.js' },
    // netbacking-audit retiré : service vide (« Hello World »), le journal d'audit est géré par netbacking-user
  ],
};
