// Lista do que cada módulo PODE enxergar. Variável nova fica invisível até
// ser adicionada aqui de propósito.
const COMMON = ['DB', 'ASSETS', 'BRAND_NAME', 'META_PIXEL_ID', 'META_API_VERSION'];
export const ALLOWED = {
  checkout: [
    ...COMMON, 'MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY', 'MP_WEBHOOK_BASE', 'STATEMENT_DESCRIPTOR',
    'GUARANTEE_DAYS', 'META_PIXEL_ACCESS_TOKEN', 'META_TEST_EVENT_CODE', 'DEBUG_APPROVE_TOKEN',
    'EMAIL', 'EMAIL_FROM', 'CLOUDFLARE_EMAIL_API_TOKEN', 'CLOUDFLARE_EMAIL_ACCOUNT_ID',
    'CLOUDFLARE_ACCOUNT_ID',
  ],
  dashboard: [
    ...COMMON, 'DASH_USER', 'DASH_PASS', 'META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID',
    'META_AD_ACCOUNT_IDS', 'META_AD_ACCOUNT_ID_2',
  ],
  site: [...COMMON, 'DEFAULT_PAGE', 'META_PIXEL_ACCESS_TOKEN', 'META_TEST_EVENT_CODE'],
};

export function envFor(module, env) {
  const scoped = {};
  for (const key of ALLOWED[module]) {
    if (key in env) scoped[key] = env[key];
  }
  return scoped;
}
