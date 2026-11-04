# Administration AccesFinance — routes et fonctionnement

Toutes les routes `admin/...` exigent un token **ADMIN** ou **SUPER_ADMIN**
(`Authorization: Bearer <token>`). Header optionnel : `lang: fr | en | sw`.

---

## 0. Ce qui change pour TOUTES les requêtes authentifiées

Le guard JWT vérifie maintenant en base (cache 15 s) :

| Situation | Réponse | `code` |
|---|---|---|
| Compte `SUSPENDED`, `INACTIVE` ou `DELETED` | 403 | `ACCOUNT_BLOCKED` |
| Session fermée (déconnexion, déconnexion forcée) | 401 | `SESSION_REVOKED` |
| Mode maintenance (sauf ADMIN / SUPER_ADMIN) | 503 | `MAINTENANCE` |

- Le **rôle est relu en base** : un changement de rôle s'applique sans reconnexion.
- Les apps doivent gérer `SESSION_REVOKED` et `ACCOUNT_BLOCKED` → retour à l'écran de connexion,
  et `MAINTENANCE` → écran de maintenance avec le `message`.

---

## 1. Clients & comptes bancaires

| Méthode | Route | Description |
|---|---|---|
| GET | `admin/clients/:clientId` | Fiche banque + comptes + soldes par devise + compte appli (statut, PIN…) |
| GET | `admin/accounts/:accountNumber` | Détail du compte, propriétaire, 10 dernières opérations |
| GET | `admin/accounts/:accountNumber/transactions` | Historique (plus récent d'abord) |
| GET | `admin/accounts/:accountNumber/transactions/export` | **CSV** de l'historique |
| GET | `admin/accounts/:accountNumber/statement` | Relevé de compte |
| GET | `admin/users/:userId/transactions` | Historique de tous les comptes d'un utilisateur |
| GET | `admin/users/:userId/beneficiaries` | Bénéficiaires d'un utilisateur (`?search=`) |
| GET | `admin/transactions/:id` | Détail d'une transaction (`?accountNumber=` pour chercher aussi dans l'historique) |
| GET | `admin/accounts/:accountNumber/statement/download` | **Relevé PDF** (`?startDate=&endDate=&format=base64&sendEmail=true&email=`) |

Filtres d'historique : `page`, `limit`, `type`, `status`, `movement` (`CREDIT`/`DEBIT`),
`startDate`, `endDate` (`AAAA-MM-JJ`).

---

## 2. Sécurité des comptes

| Méthode | Route | Effet |
|---|---|---|
| GET | `admin/users/:userId/security` | PIN, verrouillages, sessions actives, connexions, actions admin |
| POST | `admin/users/:userId/unlock-pin` | Remet les erreurs PIN à 0, lève le blocage (statut LOCKED → ACTIVE) |
| POST | `admin/users/:userId/reset-pin` | Supprime le PIN : l'utilisateur doit en créer un nouveau |
| POST | `admin/users/:userId/block` | Statut `SUSPENDED` + fermeture de toutes les sessions |
| POST | `admin/users/:userId/unblock` | Statut `ACTIVE` + levée des verrouillages PIN et connexion |
| POST | `admin/users/:userId/force-logout` | Ferme toutes les sessions (tous les appareils) |
| POST | `admin/users/:userId/reset-password` | Nouveau mot de passe temporaire par SMS / email |

Body optionnel :
```json
{ "reason": "Demande du client en agence", "notify": true }
```
- `notify: false` → pas de SMS à l'utilisateur.
- Un admin **n'agit jamais sur son propre compte**.
- Seul un **SUPER_ADMIN** agit sur un ADMIN / SUPER_ADMIN.
- Chaque action est tracée dans `audit_logs` (`entity = USER_SECURITY`, ancienne et nouvelle valeur).

---

## 3. Contrôle des opérations

| Méthode | Route | Accès |
|---|---|---|
| GET | `admin/settings/operations` | ADMIN, SUPER_ADMIN |
| PATCH | `admin/settings/operations` | **SUPER_ADMIN** |
| GET | `settings/operations/public` | Public (apps) |
| GET | `admin/settings/limits/:userId` | Limites d'un utilisateur : propres, globales et effectives |
| PATCH | `admin/settings/limits/:userId` | Limites propres à un utilisateur (priment sur les globales) |
| DELETE | `admin/settings/limits/:userId` | Retour aux limites globales |
| GET / PATCH | `admin/settings/general` | Paramètres généraux de l'application (fusion, pas d'écrasement) |

Exemple de limites par utilisateur :
```json
{ "USD": { "maxPerOperation": 5000, "maxDailyPerUser": 20000 }, "transfersEnabled": true, "note": "Commerçant" }
```
`null` = aucune limite pour cet utilisateur ; champ absent = limite globale.
`transfersEnabled: false` coupe les transferts de cet utilisateur uniquement.

Exemple de `PATCH` (on peut n'envoyer qu'une partie) :
```json
{
  "maintenanceMode": false,
  "maintenanceMessage": "Maintenance en cours, retour à 14h.",
  "transfersEnabled": true,
  "depositsEnabled": true,
  "withdrawalsEnabled": true,
  "limits": {
    "USD": { "minPerOperation": 1,   "maxPerOperation": 1000,    "maxDailyPerUser": 3000 },
    "CDF": { "minPerOperation": 100, "maxPerOperation": 2000000, "maxDailyPerUser": 5000000 }
  }
}
```
- `null` = pas de limite.
- Appliqué aux **transferts, dépôts et retraits**, **avant** le PIN et l'OTP.
- Plafond journalier : calculé depuis minuit (heure de Lubumbashi) sur les opérations
  réussies de l'utilisateur.
- Les services gardent la valeur en cache **15 s** : un changement s'applique en 15 s maximum.
- Stocké dans la table `settings` (clé `operation_controls`) : **aucune migration SQL**.

Codes d'erreur renvoyés aux apps : `MAINTENANCE`, `OPERATION_DISABLED_TRANSFER`,
`OPERATION_DISABLED_DEPOSIT`, `OPERATION_DISABLED_WITHDRAWAL`, `OPERATION_AMOUNT_INVALID`,
`OPERATION_AMOUNT_BELOW_MIN`, `OPERATION_AMOUNT_ABOVE_MAX`, `OPERATION_DAILY_LIMIT_EXCEEDED`.

---

## 4. Supervision & rapports

| Méthode | Route | Description |
|---|---|---|
| GET | `admin/monitoring/bank` | Santé de l'API banque : statut `UP` / `DEGRADED` / `DOWN`, test en direct, stats par endpoint, dernières erreurs (`?live=false` = sans appel banque) |
| GET | `admin/monitoring/sms` | Journal des SMS : envoyés / échoués, taux de succès (`?status=SENT\|FAILED&phone=&from=&to=&page=&limit=`) |
| GET | `admin/reports/operations` | Totaux par opération et devise, évolution par jour, top utilisateurs, dernières opérations (`?from=&to=&action=TRANSFER\|DEPOSIT\|WITHDRAWAL&currency=&userId=`) |
| GET | `admin/reports/operations/export` | **CSV** des opérations (mêmes filtres) |
| GET | `admin/stats/users` | Utilisateurs **MOBILE / WEB** : inscrits, par statut, nouveaux, actifs sur la période, connexions, en ligne maintenant, appareils prêts pour les notifications (`?from=&to=`) |
| GET | `admin/stats/transactions` | **Volumes** : par devise, par type, par plateforme, évolution, top utilisateurs (filtres ci-dessous) |
| GET | `admin/transactions` | **Toutes les transactions bancaires** de tous les clients (tous les comptes), avec volumes par devise / type / mouvement — filtres : `from`, `to`, `clientId`, `userId`, `accountNumber`, `type`, `movement`, `status`, `currency`, `minAmount`, `maxAmount`, `search`, `sort`, `page`, `limit`, `refresh=true` |
| GET | `admin/transactions/export` | **CSV** de toutes les transactions bancaires (mêmes filtres) |
| GET | `admin/transactions/app` | Opérations faites via l'application (avec plateforme MOBILE / WEB) |
| GET | `admin/transactions/app/export` | CSV des opérations faites via l'application |
| POST | `admin/notifications/send` | Notification à un utilisateur (`userId`) ou à un groupe (`audience`: `ALL`, `MOBILE`, `WEB` — SUPER_ADMIN) |
| GET | `admin/monitoring/email` | État de l'envoi d'emails (config, dernière erreur SMTP) — `?verify=false` pour ne pas tester la connexion |
| POST | `admin/monitoring/email/test` | Envoie un email de test — body `{ "to": "adresse@exemple.com" }` |

**Filtres des transactions** : `from`, `to` (AAAA-MM-JJ), `type` (`TRANSFER`, `DEPOSIT`, `WITHDRAWAL`, plusieurs séparés par une virgule),
`currency` (`USD`/`CDF`), `platform` (`MOBILE`/`WEB`), `status`, `userId`, `accountNumber`, `minAmount`, `maxAmount`,
`search` (référence, id banque, nom, compte, code client), `groupBy` (`day`/`week`/`month`), `sort`
(`date_desc`, `date_asc`, `amount_desc`, `amount_asc`), `page`, `limit`.

- Période par défaut : 30 derniers jours. Format `AAAA-MM-JJ`.
- Les CSV utilisent le séparateur `;` et l'encodage UTF-8 avec BOM : ils s'ouvrent directement dans Excel.
- Le journal SMS **masque les codes OTP** (`******`) et **ne stocke jamais les mots de passe**.
- Les rapports portent sur les opérations faites via l'application (tracées après validation
  par la banque). Les opérations en agence n'y figurent pas.
- Les statistiques de l'API banque sont remises à zéro au redémarrage de `transaction-service`.

---

## 5. Variables `.env` ajoutées

| Variable | Défaut | Rôle |
|---|---|---|
| `SESSION_CHECK_ENABLED` | `true` | Vérification session / statut / maintenance à chaque requête |
| `SESSION_CHECK_CACHE_MS` | `15000` | Durée du cache de cette vérification |
| `OPERATION_CONTROLS_CACHE_MS` | `15000` | Durée du cache des contrôles d'opérations |
| `SHARED_PRISMA_CONNECTION_LIMIT` | `3` | Connexions MySQL du client partagé (guard + journal SMS) |
| `BANK_HEALTH_CLIENT_ID` | — | Client de test pour le test en direct de l'API banque |
| `SMS_LOG_ENABLED` | `true` | Journal des SMS dans `audit_logs` |
| `DREAM_SMS_API_ID`, `DREAM_SMS_API_PASSWORD`, `DREAM_SMS_API_URL`, `DREAM_SMS_SENDER` | valeurs actuelles | Fournisseur SMS Dream Digital (les anciennes `SMS_API_URL` / `SMS_SENDER` du `.env` sont des exemples et ne sont pas utilisées) |
| `APP_TZ_OFFSET` | `+02:00` | Fuseau (Lubumbashi) pour « aujourd'hui » et les rapports |
| `ADMIN_REPORT_MAX_ROWS` | `50000` | Nombre max de lignes par rapport / export |

---

## 6. Redémarrage

Redémarrer **api-gateway**, **auth-service**, **user-service** et **transaction-service**.
