-- AccesFinance — sessions : tokens JWT plus longs que 255 caractères (comptes admin)
-- À exécuter une seule fois dans MySQL (base netbacking_db)
ALTER TABLE `sessions`
  MODIFY `token` VARCHAR(768) NOT NULL,
  MODIFY `refreshToken` VARCHAR(768) NOT NULL;
