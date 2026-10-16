// Leitura da oferta (tabela offers) usada pelas páginas e pelo relay da CAPI.
// O token da CAPI nunca sai do servidor: só é lido aqui para o relay.

export const OFFER_CODE_RE = /^[a-z0-9_-]{1,64}$/i;

export function isValidOfferCode(code) {
  return typeof code === 'string' && OFFER_CODE_RE.test(code);
}

// Retorna a linha da oferta ou null (código inválido, oferta inexistente ou
// erro de banco). Nunca lança: a página continua no ar sem a oferta.
export async function loadOffer(env, code) {
  if (!isValidOfferCode(code) || !env || !env.DB) return null;
  try {
    const row = await env.DB
      .prepare('SELECT code, name, sale_price_cents, is_active, meta_pixel_id, meta_capi_token FROM offers WHERE code = ? LIMIT 1')
      .bind(code.toLowerCase())
      .first();
    return row || null;
  } catch {
    return null;
  }
}
