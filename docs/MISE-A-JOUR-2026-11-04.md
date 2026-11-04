# Mise à jour AccesFinance — 4 novembre 2026

## Ce qui change

### 1. Emails (ne partaient pas)
- Le service ne se désactive plus définitivement si la vérification SMTP échoue au démarrage.
- `user-service` (qui envoie le mot de passe temporaire) charge enfin le `.env`.
- Port converti en nombre, `secure` déduit du port 465, mot de passe Google sans espaces.
- Erreurs SMTP détaillées dans les logs (identifiants refusés, port bloqué…).
- Nouveau gabarit AccesFinance avec le logo intégré à chaque email.
- Diagnostic : `GET admin/monitoring/email` et `POST admin/monitoring/email/test`.

### 2. Notifications (même procédure que le portefeuille de référence)
- Chaque transfert, dépôt et retrait : **SMS + push + historique**, selon les réglages
  (SMS / push activés) et la langue de chaque utilisateur. Le destinataire d'un transfert
  est aussi notifié s'il utilise l'application.
- Corrigé : Firebase ne démarrait pas, le token du téléphone n'était jamais trouvé,
  et l'enregistrement en base échouait (type invalide).
- Routes utilisateur :

| Méthode | Route |
|---|---|
| GET | `users/me/notifications?page=&limit=&unreadOnly=true` |
| GET | `users/me/notifications/unread-count` |
| PATCH | `users/me/notifications/:id/read` |
| PATCH | `users/me/notifications/read-all` |
| DELETE | `users/me/notifications/:id` |
| POST | `users/me/device-token` — body `{ "fcmToken": "…", "platform": "MOBILE" }` |

- Actions de sécurité de l'admin (blocage, PIN, déconnexion, mot de passe) : push en plus du SMS.

### 3. Relevé de compte PDF
- Même apparence que le relevé du portefeuille de référence, logo et couleurs AccesFinance.

| Méthode | Route |
|---|---|
| GET | `transactions/statement/:accountNumber/download?startDate=&endDate=` → fichier PDF |
| GET | `…/download?format=base64` → JSON `{ filename, pdfBase64 }` (pratique pour le mobile) |
| GET | `…/download?sendEmail=true` → PDF téléchargé **et** envoyé à l'email du client |

### 4. Autres routes ajoutées
`GET/PATCH users/me/profile`, `DELETE users/me/account` (body `{ "password": "…" }` — supprime
l'accès à l'application, pas le compte bancaire), et les routes admin listées dans `docs/ADMIN.md`
(statistiques mobile/web, volumes et liste des transactions avec filtres, limites par utilisateur,
notifications, emails).

### 5. Marque
Tous les emails et documents : AccesFinance, logo (`public/brand/`), couleur `#0260C2`.
Les modèles `templates/auth/*.html` des autres projets ont été remplacés.

---

## Déploiement

```bash
cd ~/accesfin

# 1. Migration SQL (plateforme des connexions, tokens de notification)
mysql -u admin -p netbacking_db < prisma/sql/20261104_platform_tracking.sql

# 2. Client Prisma (nouveau schéma)
npx prisma generate

# 3. Navigateur pour les relevés PDF (une seule fois)
#    soit Chromium du système :
sudo apt install -y chromium-browser || sudo apt install -y chromium
#    soit le navigateur de puppeteer :
npx puppeteer browsers install chrome

# 4. Compilation et redémarrage
npm run build api-gateway && npm run build auth-service && npm run build user-service && npm run build transaction-service
pm2 restart all --update-env
```

### Variables `.env` facultatives
| Variable | Rôle |
|---|---|
| `COMPANY_ADDRESS`, `COMPANY_PHONE`, `COMPANY_EMAIL`, `COMPANY_WEBSITE` | Coordonnées affichées sur les emails et le relevé |
| `MAILER_FROM` | Expéditeur des emails, ex. `"AccesFinance" <noreply@accesfinance.africa>` |
| `PUPPETEER_EXECUTABLE_PATH` | Chemin du navigateur si détection automatique impossible |

### Si les emails ne partent toujours pas
1. `GET admin/monitoring/email` → lire `lastVerifyError`.
2. `[EAUTH]` : utiliser un **mot de passe d'application** Google (validation en 2 étapes activée).
3. `[ETIMEDOUT]` / `[ECONNECTION]` : l'hébergeur bloque le port SMTP. Tester :
   `nc -vz smtp.gmail.com 587` puis `nc -vz smtp.gmail.com 465`, et mettre
   `MAILER_PORT=465` + `MAILER_SECURE=true` si seul le 465 répond.
