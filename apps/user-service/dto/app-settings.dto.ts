export class UpsertAppSettingsDto {
  app_name?: string;
  slogan?: string;
  description?: string;
  email?: string;
  phone?: string;
  address?: string;
  default_language?: string;
  default_currency?: string;
  timezone?: string;
  logo?: string;
  favicon?: string;
  primary_color?: string;
  secondary_color?: string;
  maintenance_mode?: boolean;
  maintenance_message?: string;
  allow_registration?: boolean;
  transfer_fee?: number;
  withdraw_fee?: number;
  facebook?: string;
  instagram?: string;
  twitter?: string;
  stripe_enabled?: boolean;
  paypal_enabled?: boolean;
  mobile_money_enabled?: boolean;
}
