// libs/common/src/branding/statement-template.ts
import { BRAND, escapeHtml as e } from './brand';

/**
 * ═══════════════════════════════════════════════════════════════════
 * RELEVÉ DE COMPTE — gabarit officiel AccesFinance
 * aux couleurs et avec le logo AccesFinance, sans ombre.
 * ═══════════════════════════════════════════════════════════════════
 */

export interface StatementRow {
  description: string;
  detail?: string;
  reference: string;
  date: string;
  credit: string | null;
  debit: string | null;
  balance: string;
}

export interface StatementContext {
  lang: string;
  logoDataUri: string;
  periodStart: string;
  periodEnd: string;
  generatedDate: string;
  currency: string;
  client: {
    fullName: string;
    clientId: string;
    accountNumber: string;
    accountType: string;
    phone: string;
    email: string;
  };
  totals: {
    opening: string;
    credits: string;
    debits: string;
    balance: string;
    count: number;
  };
  transactions: StatementRow[];
  labels: Record<string, string>;
}

const LABELS: Record<string, Record<string, string>> = {
  fr: {
    title: 'RELEVÉ DE COMPTE',
    period: 'Période',
    clientInfo: 'INFORMATIONS CLIENT',
    summary: 'RÉCAPITULATIF',
    details: 'Détails',
    reference: 'Référence',
    date: 'Date',
    credit: 'Crédit (Entrée)',
    debit: 'Débit (Sortie)',
    balance: 'Solde',
    totals: 'TOTAUX',
    noTransactions: 'Aucune transaction sur cette période',
    footerText: 'Ce document est un relevé de compte officiel AccesFinance',
    generatedOn: 'Relevé généré le',
    fullName: 'Nom complet',
    clientId: 'Code client',
    accountNumber: 'N° Compte',
    accountType: 'Type de compte',
    phone: 'Téléphone',
    email: 'Email',
    openingBalance: 'Solde initial',
    totalCredits: 'Total Crédits (Entrées)',
    totalDebits: 'Total Débits (Sorties)',
    finalBalance: 'Solde final',
    operations: 'Opérations',
    page: 'Page',
    of: 'sur',
    deposit: 'Dépôt',
    withdrawal: 'Retrait',
    transfer: 'Transfert',
    payment: 'Paiement',
    fee: 'Frais',
    operation: 'Opération',
    allTimeStart: 'Début',
    allTimeEnd: "Aujourd'hui",
  },
  en: {
    title: 'ACCOUNT STATEMENT',
    period: 'Period',
    clientInfo: 'CLIENT INFORMATION',
    summary: 'SUMMARY',
    details: 'Details',
    reference: 'Reference',
    date: 'Date',
    credit: 'Credit (In)',
    debit: 'Debit (Out)',
    balance: 'Balance',
    totals: 'TOTALS',
    noTransactions: 'No transactions in this period',
    footerText: 'This is an official AccesFinance account statement',
    generatedOn: 'Generated on',
    fullName: 'Full name',
    clientId: 'Client code',
    accountNumber: 'Account number',
    accountType: 'Account type',
    phone: 'Phone',
    email: 'Email',
    openingBalance: 'Opening balance',
    totalCredits: 'Total Credits (In)',
    totalDebits: 'Total Debits (Out)',
    finalBalance: 'Final balance',
    operations: 'Transactions',
    page: 'Page',
    of: 'of',
    deposit: 'Deposit',
    withdrawal: 'Withdrawal',
    transfer: 'Transfer',
    payment: 'Payment',
    fee: 'Fee',
    operation: 'Transaction',
    allTimeStart: 'Beginning',
    allTimeEnd: 'Today',
  },
  sw: {
    title: 'TAARIFA YA AKAUNTI',
    period: 'Kipindi',
    clientInfo: 'TAARIFA ZA MTEJA',
    summary: 'MUHTASARI',
    details: 'Maelezo',
    reference: 'Kumbukumbu',
    date: 'Tarehe',
    credit: 'Kuingia',
    debit: 'Kutoka',
    balance: 'Salio',
    totals: 'JUMLA',
    noTransactions: 'Hakuna miamala katika kipindi hiki',
    footerText: 'Hii ni taarifa rasmi ya akaunti ya AccesFinance',
    generatedOn: 'Imetolewa tarehe',
    fullName: 'Jina kamili',
    clientId: 'Namba ya mteja',
    accountNumber: 'Namba ya akaunti',
    accountType: 'Aina ya akaunti',
    phone: 'Simu',
    email: 'Barua pepe',
    openingBalance: 'Salio la mwanzo',
    totalCredits: 'Jumla ya Kuingia',
    totalDebits: 'Jumla ya Kutoka',
    finalBalance: 'Salio la mwisho',
    operations: 'Miamala',
    page: 'Ukurasa',
    of: 'kati ya',
    deposit: 'Kuweka',
    withdrawal: 'Kutoa',
    transfer: 'Uhamisho',
    payment: 'Malipo',
    fee: 'Ada',
    operation: 'Muamala',
    allTimeStart: 'Mwanzo',
    allTimeEnd: 'Leo',
  },
};

export function statementLabels(lang: string): Record<string, string> {
  return LABELS[lang] || LABELS.fr;
}

export function renderStatementHtml(c: StatementContext): string {
  const L = { ...statementLabels(c.lang), ...(c.labels || {}) };
  const col = BRAND.colors;
  const contact = [
    BRAND.phone ? `<p>Tél : ${e(BRAND.phone)}</p>` : '',
    BRAND.email ? `<p>Email : ${e(BRAND.email)}</p>` : '',
    BRAND.website ? `<p>Web : ${e(BRAND.website.replace(/^https?:\/\//, ''))}</p>` : '',
  ].join('');

  const rows = c.transactions.length
    ? c.transactions
        .map(
          (tx, i) => `
          <tr style="background-color:${i % 2 === 0 ? '#ffffff' : '#eef3fb'}">
            <td>
              <div class="description-text">${e(tx.description)}</div>
              ${tx.detail ? `<div class="user-name">${e(tx.detail)}</div>` : ''}
            </td>
            <td><span class="reference-text">${e(tx.reference)}</span></td>
            <td>${e(tx.date)}</td>
            <td class="text-right credit-amount">${tx.credit ? `${e(tx.credit)} ${e(c.currency)}` : '-'}</td>
            <td class="text-right debit-amount">${tx.debit ? `${e(tx.debit)} ${e(c.currency)}` : '-'}</td>
            <td class="text-right balance-amount">${e(tx.balance)} ${e(c.currency)}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" style="text-align:center;padding:18px;">${e(L.noTransactions)}</td></tr>`;

  return `<!doctype html>
<html lang="${e(c.lang)}">
<head>
  <meta charset="UTF-8" />
  <title>AccesFinance - ${e(L.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: ${col.text}; background: #ffffff; }
    .print-container { background-color: white; width: 100%; padding: 20px; }

    .header { border-bottom: 3px solid ${col.primary}; padding-bottom: 18px; margin-bottom: 22px; }
    .header-content { display: flex; justify-content: space-between; align-items: flex-start; }
    .logo-section { margin-bottom: 8px; }
    .logo-section img { height: 58px; width: auto; display: block; }
    .company-address { font-size: 11px; color: ${col.muted}; margin-top: 6px; }
    .contact-info { font-size: 10px; color: ${col.muted}; margin-top: 4px; }
    .contact-info p { margin: 2px 0; }

    .title-box { text-align: center; margin: 4px 0 18px 0; }
    .title-box h2 { font-size: 20px; font-weight: bold; color: #000000; margin: 0; letter-spacing: 1px; }
    .title-box p { font-size: 10px; color: ${col.muted}; margin-top: 4px; }

    .info-section { display: flex; justify-content: space-between; margin-bottom: 22px; padding: 14px; border: 1px solid ${col.border}; border-radius: 8px; }
    .client-info { flex: 1; }
    .client-info h3, .totals-info h3 { font-size: 12px; font-weight: bold; color: #000000; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
    .client-details { font-size: 10px; color: #374151; line-height: 1.6; }
    .client-details p { margin: 3px 0; }
    .client-details .label { font-weight: 600; color: ${col.muted}; min-width: 95px; display: inline-block; }

    .totals-info { min-width: 290px; padding-left: 20px; border-left: 1px solid ${col.border}; }
    .totals-table { width: 100%; font-size: 11px; border-collapse: collapse; }
    .totals-table tr td { padding: 5px 0; }
    .totals-table tr td:first-child { font-weight: 600; color: ${col.muted}; }
    .totals-table tr td:last-child { text-align: right; font-weight: 700; }
    .totals-table .credit-row td:last-child { color: #000000; }
    .totals-table .debit-row td:last-child { color: #000000; }
    .totals-table .balance-row td:last-child { color: ${col.primary}; font-size: 13px; }
    .totals-table .separator td { border-bottom: 1px solid ${col.border}; padding: 0; height: 1px; }

    .transactions-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    .transactions-table thead { display: table-header-group; }
    .transactions-table tr { page-break-inside: avoid; }
    .transactions-table th { padding: 10px 6px; text-align: left; color: white; font-size: 10px; font-weight: 600; border: 1px solid white; border-top: none; }
    .transactions-table th:first-child { border-left: none; }
    .transactions-table th:last-child { border-right: none; }
    .transactions-table th.text-right, .transactions-table td.text-right { text-align: right; }
    .transactions-table td { padding: 8px 6px; font-size: 9px; border: 1px solid white; vertical-align: top; }

    .description-text { font-weight: 600; margin-bottom: 3px; font-size: 9px; }
    .user-name { font-size: 8px; color: ${col.muted}; }
    .reference-text { font-family: monospace; font-size: 9px; }
    .credit-amount { color: #000000; font-weight: 600; white-space: nowrap; }
    .debit-amount { color: #000000; font-weight: 600; white-space: nowrap; }
    .balance-amount { font-weight: 600; white-space: nowrap; }

    .footer { border-top: 1px solid ${col.border}; padding-top: 14px; margin-top: 14px; text-align: center; font-size: 9px; color: #9ca3af; }
    .footer p { margin: 0 0 4px 0; }
  </style>
</head>
<body>
  <div class="print-container">
    <div class="header">
      <div class="header-content">
        <div>
          <div class="logo-section">
            ${c.logoDataUri ? `<img src="${c.logoDataUri}" alt="${e(BRAND.displayName)}" />` : `<h1 style="color:${col.primary};font-size:24px;">${e(BRAND.displayName)}</h1>`}
          </div>
          <p class="company-address">${e(BRAND.address)}</p>
          <div class="contact-info">${contact}</div>
        </div>
      </div>
    </div>

    <div class="title-box">
      <h2>${e(L.title)}</h2>
      <p>${e(L.period)} : ${e(c.periodStart)} - ${e(c.periodEnd)}</p>
    </div>

    <div class="info-section">
      <div class="client-info">
        <h3>${e(L.clientInfo)}</h3>
        <div class="client-details">
          <p><span class="label">${e(L.fullName)} :</span> ${e(c.client.fullName)}</p>
          <p><span class="label">${e(L.clientId)} :</span> ${e(c.client.clientId)}</p>
          <p><span class="label">${e(L.accountNumber)} :</span> ${e(c.client.accountNumber)}</p>
          <p><span class="label">${e(L.accountType)} :</span> ${e(c.client.accountType)} (${e(c.currency)})</p>
          <p><span class="label">${e(L.phone)} :</span> ${e(c.client.phone)}</p>
          <p><span class="label">${e(L.email)} :</span> ${e(c.client.email)}</p>
        </div>
      </div>
      <div class="totals-info">
        <h3>${e(L.summary)}</h3>
        <table class="totals-table">
          <tr><td>${e(L.openingBalance)} :</td><td>${e(c.totals.opening)} ${e(c.currency)}</td></tr>
          <tr class="credit-row"><td>${e(L.totalCredits)} :</td><td>${e(c.totals.credits)} ${e(c.currency)}</td></tr>
          <tr class="debit-row"><td>${e(L.totalDebits)} :</td><td>${e(c.totals.debits)} ${e(c.currency)}</td></tr>
          <tr class="separator"><td colspan="2"></td></tr>
          <tr class="balance-row"><td>${e(L.finalBalance)} :</td><td>${e(c.totals.balance)} ${e(c.currency)}</td></tr>
          <tr><td>${e(L.operations)} :</td><td>${c.totals.count}</td></tr>
        </table>
      </div>
    </div>

    <table class="transactions-table">
      <thead>
        <tr style="background-color:${col.primary}">
          <th>${e(L.details)}</th>
          <th>${e(L.reference)}</th>
          <th>${e(L.date)}</th>
          <th class="text-right">${e(L.credit)}</th>
          <th class="text-right">${e(L.debit)}</th>
          <th class="text-right">${e(L.balance)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="background-color:#f3f4f6">
          <td colspan="3" style="padding:8px 6px;text-align:right;font-weight:bold;">${e(L.totals)} :</td>
          <td class="text-right credit-amount">${e(c.totals.credits)} ${e(c.currency)}</td>
          <td class="text-right debit-amount">${e(c.totals.debits)} ${e(c.currency)}</td>
          <td class="text-right balance-amount">${e(c.totals.balance)} ${e(c.currency)}</td>
        </tr>
      </tfoot>
    </table>

    <div class="footer">
      <p>${e(L.footerText)}</p>
      <p>${e(L.generatedOn)} ${e(c.generatedDate)}</p>
    </div>
  </div>
</body>
</html>`;
}
