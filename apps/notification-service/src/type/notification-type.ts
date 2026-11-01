// apps/notification-service/src/type/notification-type.ts
export enum NotificationType {
  // ===== TRANSACTIONS =====
  DEPOSIT_SUCCESS = 'deposit_success',
  CASHOUT_SUCCESS = 'cashout_success',
  TRANSFER_SENT = 'transfer_sent',
  TRANSFER_RECEIVED = 'transfer_received',
  PAYMENT_SENT = 'payment_sent',
  PAYMENT_RECEIVED = 'payment_received',
  
  // ===== COMPTE =====
  ACCOUNT_LOCKED = 'account_locked',
  ACCOUNT_UNLOCKED = 'account_unlocked',
  PASSWORD_CHANGED = 'password_changed',
  PIN_CHANGED = 'pin_changed',
  PIN_CREATED = 'pin_created',
  LOGIN_ALERT = 'login_alert',
  LOGIN_FAILED = 'login_failed',
  
  // ===== SÉCURITÉ =====
  SECURITY_ALERT = 'security_alert',
  TWO_FA_ENABLED = 'two_fa_enabled',
  TWO_FA_DISABLED = 'two_fa_disabled',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  
  // ===== SYSTÈME =====
  SYSTEM = 'system',
  MAINTENANCE = 'maintenance',
  UPDATE_AVAILABLE = 'update_available',
  
  // ===== PROMOTIONS =====
  PROMO = 'promo',
  OFFER_AVAILABLE = 'offer_available',
  REFERRAL_BONUS = 'referral_bonus',
}

// Helper pour les catégories
export const NotificationCategory = {
  [NotificationType.DEPOSIT_SUCCESS]: 'transaction',
  [NotificationType.CASHOUT_SUCCESS]: 'transaction',
  [NotificationType.TRANSFER_SENT]: 'transaction',
  [NotificationType.TRANSFER_RECEIVED]: 'transaction',
  [NotificationType.PAYMENT_SENT]: 'transaction',
  [NotificationType.PAYMENT_RECEIVED]: 'transaction',
  [NotificationType.ACCOUNT_LOCKED]: 'account',
  [NotificationType.ACCOUNT_UNLOCKED]: 'account',
  [NotificationType.PASSWORD_CHANGED]: 'account',
  [NotificationType.PIN_CHANGED]: 'account',
  [NotificationType.LOGIN_ALERT]: 'security',
  [NotificationType.SECURITY_ALERT]: 'security',
  [NotificationType.TWO_FA_ENABLED]: 'security',
  [NotificationType.TWO_FA_DISABLED]: 'security',
  [NotificationType.SYSTEM]: 'system',
  [NotificationType.MAINTENANCE]: 'system',
  [NotificationType.PROMO]: 'promo',
} as const;

// Helper pour les icônes
export const NotificationIcon = {
  [NotificationType.DEPOSIT_SUCCESS]: '💰',
  [NotificationType.CASHOUT_SUCCESS]: '💳',
  [NotificationType.TRANSFER_SENT]: '📤',
  [NotificationType.TRANSFER_RECEIVED]: '📥',
  [NotificationType.PAYMENT_SENT]: '💸',
  [NotificationType.PAYMENT_RECEIVED]: '💵',
  [NotificationType.ACCOUNT_LOCKED]: '🔒',
  [NotificationType.ACCOUNT_UNLOCKED]: '🔓',
  [NotificationType.PASSWORD_CHANGED]: '🔑',
  [NotificationType.PIN_CHANGED]: '🔢',
  [NotificationType.LOGIN_ALERT]: '🖥️',
  [NotificationType.SECURITY_ALERT]: '⚠️',
  [NotificationType.TWO_FA_ENABLED]: '✅',
  [NotificationType.TWO_FA_DISABLED]: '❌',
  [NotificationType.SYSTEM]: '⚙️',
  [NotificationType.MAINTENANCE]: '🔧',
  [NotificationType.PROMO]: '🎉',
} as const;