// E-mail transacional de confirmação de compra.
//
// Transporte preferido: binding `send_email` do Workers (env.EMAIL.send).
// Sem binding, usa a REST API de envio da Cloudflare com
// CLOUDFLARE_EMAIL_API_TOKEN + CLOUDFLARE_EMAIL_ACCOUNT_ID.
// O remetente vem sempre de EMAIL_FROM ("contato@dominio" ou
// "Nome <contato@dominio>"); sem ele o envio é tratado como não configurado.

import { configValue } from './utils.js';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_SUBJECT = 'Sua compra de {{produto}} foi confirmada';
const DEFAULT_BODY = 'Olá, {{nome}}.\n\n'
  + 'Sua compra de {{produto}} foi confirmada. Obrigado pela confiança!\n\n'
  + 'Guarde este e-mail como comprovante da sua compra.';
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new Error('invalid_recipient_email');
  }
  return email;
}

// Aceita "contato@dominio" ou "Nome <contato@dominio>". Retorna null se inválido.
export function parseSender(value) {
  const raw = configValue(value);
  if (!raw) return null;
  const named = raw.match(/^\s*"?([^"<>]*?)"?\s*<\s*([^<>\s]+)\s*>\s*$/);
  const email = (named ? named[2] : raw).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  const name = named ? named[1].trim().slice(0, 120) : '';
  return { email, name };
}

function emailAccountId(env) {
  return configValue(env && (env.CLOUDFLARE_EMAIL_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID));
}

function hasEmailBinding(env) {
  return Boolean(env && env.EMAIL && typeof env.EMAIL.send === 'function');
}

// Há remetente válido e algum transporte disponível (binding ou REST)?
export function isEmailConfigured(env) {
  if (!parseSender(env && env.EMAIL_FROM)) return false;
  if (hasEmailBinding(env)) return true;
  return Boolean(configValue(env && env.CLOUDFLARE_EMAIL_API_TOKEN) && emailAccountId(env));
}

// Substituição por função: nome (digitado pelo comprador) e produto (do banco)
// podem conter $&, $' ou $`, que um replacement em string expandiria.
function fillPlaceholders(template, values) {
  return String(template)
    .replace(/\{\{\s*nome\s*\}\}/gi, () => values.nome)
    .replace(/\{\{\s*produto\s*\}\}/gi, () => values.produto);
}

function safeAccessUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

// Monta a mensagem de confirmação a partir dos campos de e-mail da oferta:
//   offer.email_subject    (padrão: "Sua compra de {{produto}} foi confirmada")
//   offer.email_body       (texto puro; aceita {{nome}} e {{produto}})
//   offer.email_access_url (opcional; vira um botão "Acessar")
// `from` é o EMAIL_FROM da instância; `brand` (opcional) assina o rodapé e
// serve de nome do remetente quando EMAIL_FROM não traz um.
export function buildPurchaseEmail({ name, email, offer, from, brand }) {
  const to = normalizeEmail(email);
  const sender = parseSender(from);
  if (!sender) throw new Error('email_from_not_configured');

  const o = offer || {};
  const firstName = String(name || '').trim().split(/\s+/)[0] || 'Cliente';
  const productName = String(o.name || '').trim() || 'seu produto';
  const brandName = configValue(brand).slice(0, 120);
  const values = { nome: firstName, produto: productName };

  const subjectTemplate = String(o.email_subject || '').trim() || DEFAULT_SUBJECT;
  const subject = fillPlaceholders(subjectTemplate, values).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const bodyTemplate = String(o.email_body || '').replace(/\r\n?/g, '\n').trim() || DEFAULT_BODY;
  const bodyText = fillPlaceholders(bodyTemplate, values);
  const accessUrl = safeAccessUrl(o.email_access_url);

  const bodyHtml = escapeHtml(bodyText).replace(/\n/g, '<br>');
  const safeUrl = accessUrl ? escapeHtml(accessUrl) : '';
  const button = accessUrl ? `
        <p style="margin:28px 0">
          <a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:8px;font-weight:700">Acessar</a>
        </p>
        <p style="font-size:13px;color:#4b5563">Se o botão não abrir, copie este endereço:<br><a href="${safeUrl}" style="color:#111827">${safeUrl}</a></p>` : '';
  const footer = brandName ? `
        <p style="margin-top:28px;color:#4b5563">${escapeHtml(brandName)}</p>` : '';

  const textParts = [bodyText];
  if (accessUrl) textParts.push('Acessar: ' + accessUrl);
  if (brandName) textParts.push(brandName);

  return {
    to,
    from: sender.email,
    from_name: sender.name || brandName || '',
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#111827;line-height:1.6">
        <p>${bodyHtml}</p>${button}${footer}
      </div>`,
    text: textParts.join('\n\n'),
  };
}

// Envio pela REST API (POST /accounts/{id}/email/sending/send). Resolve com
// { status: 'delivered' | 'queued' } e lança em erro de API, bounce
// permanente ou destinatário não aceito.
export async function sendCloudflareTransactionalEmail({
  accountId,
  apiToken,
  message,
  fetchImpl = fetch,
}) {
  if (!accountId) throw new Error('cloudflare_email_account_not_configured');
  if (!apiToken) throw new Error('cloudflare_email_token_not_configured');
  if (!message || !message.to || !message.from || !message.subject) {
    throw new Error('cloudflare_email_invalid_message');
  }

  const response = await fetchImpl(
    `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: message.to,
        from: message.from,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    },
  );

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}

  if (!response.ok || !data || data.success !== true) {
    const code = data && Array.isArray(data.errors) && data.errors[0]
      ? String(data.errors[0].code || '')
      : '';
    throw new Error(`cloudflare_email_${response.status}${code ? `_${code}` : ''}`);
  }

  const result = data.result || {};
  const delivered = Array.isArray(result.delivered) ? result.delivered : [];
  const queued = Array.isArray(result.queued) ? result.queued : [];
  const bounced = Array.isArray(result.permanent_bounces) ? result.permanent_bounces : [];
  const recipient = String(message.to).toLowerCase();

  if (bounced.some((item) => String(item).toLowerCase() === recipient)) {
    throw new Error('cloudflare_email_permanent_bounce');
  }
  if (delivered.some((item) => String(item).toLowerCase() === recipient)) {
    return { status: 'delivered' };
  }
  if (queued.some((item) => String(item).toLowerCase() === recipient)) {
    return { status: 'queued' };
  }
  throw new Error('cloudflare_email_recipient_not_accepted');
}

// Escolhe o transporte: binding env.EMAIL quando existir, senão REST.
// Resolve com { status, transport } onde status é 'sent' (binding) ou
// 'delivered' | 'queued' (REST). Lança em erro de envio.
export async function sendTransactionalEmail({ env, message, fetchImpl }) {
  if (!message || !message.to || !message.from || !message.subject) {
    throw new Error('email_invalid_message');
  }
  if (hasEmailBinding(env)) {
    try {
      const result = await env.EMAIL.send({
        to: message.to,
        from: message.from_name ? { email: message.from, name: message.from_name } : message.from,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      return { status: 'sent', transport: 'binding', message_id: (result && result.messageId) || null };
    } catch (err) {
      const code = err && err.code ? String(err.code).slice(0, 60) : 'error';
      throw new Error('email_binding_' + code);
    }
  }
  const apiToken = configValue(env && env.CLOUDFLARE_EMAIL_API_TOKEN);
  const accountId = emailAccountId(env);
  const result = await sendCloudflareTransactionalEmail({
    accountId,
    apiToken,
    message,
    fetchImpl: fetchImpl || fetch,
  });
  return { ...result, transport: 'rest' };
}
