# Approbation des comptes & mot de passe temporaire

## 1. Inscription par le client (app / web)

`POST /auth/register`

| Étape | Corps | Réponse |
|---|---|---|
| 1 | `{ clientId }` | `{ requiresOtp: true }` — OTP envoyé (SMS + email de la banque) |
| 2 | `{ clientId, otpCode }` | `{ requiresOtp: false, pendingApproval: true, data: {...} }` |

- Le client **ne choisit plus de mot de passe** (le champ `password` est ignoré).
- Le compte est créé en `PENDING_VERIFICATION`, **sans token ni session**.
- Un client refusé peut refaire une demande (la fiche est réutilisée).

## 2. Côté admin

| Méthode | Route | Rôle |
|---|---|---|
| GET  | `/admin/registrations?page&limit&search` | Demandes en attente |
| POST | `/admin/users/:id/approve` | Approuve → `ACTIVE` + mot de passe temporaire envoyé (SMS + email) |
| POST | `/admin/users/:id/reject` `{ reason? }` | Refuse → `INACTIVE` + SMS au client |
| POST | `/admin/users/:id/resend-temp-password` | Nouveau mot de passe temporaire (perdu / expiré) |
| POST | `/admin/users` (ou `/users`) | Crée un utilisateur **approuvé directement** |
| PATCH | `/users/:id/status` `{ status: "ACTIVE" }` | Sur un compte en attente = approbation (même flux) |

Création admin :
- avec `clientId` → identité (nom, téléphone, email) reprise de l'API bancaire ;
- sans `clientId` → `firstName`, `lastName`, `phone` obligatoires (comptes internes) ;
- seul un `SUPER_ADMIN` peut créer un `ADMIN` / `SUPER_ADMIN` ;
- le champ `password` est ignoré : un mot de passe temporaire est toujours généré.

La réponse contient `data.delivery = { sms, email, phone, emailAddress, expiresAt }`.
Le mot de passe en clair n'est **jamais** renvoyé par l'API ni stocké.

## 3. Première connexion

`POST /auth/login` → `mustChangePassword: true` (réponse + `data`).

Tant que le mot de passe temporaire n'est pas changé :
- le JWT porte `mustChangePassword: true` ;
- toute l'API répond **403** `{ code: "PASSWORD_CHANGE_REQUIRED" }` sauf
  `POST /auth/change-password`, `POST /auth/logout`, `GET|PATCH /auth/profile`,
  `POST /users/me/device-token` ;
- aucun compte bancaire n'est renvoyé.

`POST /auth/change-password` `{ currentPassword, newPassword }` → renvoie de **nouveaux**
`accessToken` / `refreshToken` / `sessionId` + les comptes : le front doit les remplacer.

Codes d'erreur de connexion : `ACCOUNT_PENDING_APPROVAL`, `ACCOUNT_REJECTED`,
`TEMP_PASSWORD_EXPIRED` (validité : `TEMP_PASSWORD_EXPIRY_HOURS`, 72 h par défaut).

## 4. Comptes bancaires

Tous les comptes viennent de l'API bancaire externe (`GetClientAccounts`,
`GetAccountDetails`). Plus aucune lecture de la table locale `accounts` :
login, profil, changement de PIN, liste des clients, chéquiers, transactions.
Les chéquiers sont rattachés au **numéro** de compte (`checkbooks.accountNumber`).

## 5. Base de données

Voir `prisma/sql/20261023_user_approval_and_bank_accounts.sql`, puis `npx prisma generate`.
