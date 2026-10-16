-- Schema inicial do funil-cloudflare.
-- Datas gravadas como texto ISO no fuso de Brasília (-03:00), igual ao que o código escreve.
-- Para evoluir o banco, crie 0002_*.sql e rode `npm run migrate`.

-- ============================================================
-- Configuração
-- ============================================================

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Links exibidos em /painel (menu de páginas e ferramentas).
CREATE TABLE IF NOT EXISTS painel_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK(type IN ('public', 'internal', 'external')),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_painel_links_position ON painel_links(position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_painel_links_url ON painel_links(url);

-- ============================================================
-- Funis (/funil)
-- ============================================================

CREATE TABLE IF NOT EXISTS funnels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- source='page_view'  -> casa com page_views.page
-- source='lead_status' -> casa com leads.status
-- source='order'       -> casa com orders.status
-- match_value aceita lista separada por vírgula ou padrão LIKE (%).
CREATE TABLE IF NOT EXISTS funnel_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  funnel_id   INTEGER NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  key         TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  source      TEXT    NOT NULL CHECK (source IN ('page_view','lead_status','order')),
  match_value TEXT    NOT NULL,
  UNIQUE (funnel_id, position)
);
CREATE INDEX IF NOT EXISTS idx_funnel_steps_funnel_id ON funnel_steps(funnel_id);

-- ============================================================
-- Tráfego e leads
-- ============================================================

CREATE TABLE IF NOT EXISTS page_views (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page            TEXT    NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  referrer        TEXT,
  created_at      TEXT    NOT NULL,
  funnel          TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_term        TEXT,
  utm_content     TEXT,
  session_uuid    TEXT,
  utm_page        TEXT,
  is_bot          INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  bot_reason      TEXT,
  request_context TEXT CHECK (request_context IS NULL OR json_valid(request_context))
);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at   ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_page_views_funnel       ON page_views(funnel);
CREATE INDEX IF NOT EXISTS idx_page_views_human_funnel_page_date ON page_views(funnel, page, created_at) WHERE is_bot = 0;
CREATE INDEX IF NOT EXISTS idx_page_views_page         ON page_views(page);
CREATE INDEX IF NOT EXISTS idx_page_views_session_uuid ON page_views(session_uuid);
CREATE INDEX IF NOT EXISTS idx_page_views_utm_campaign ON page_views(utm_campaign);
CREATE INDEX IF NOT EXISTS idx_page_views_utm_page     ON page_views(utm_page);
CREATE INDEX IF NOT EXISTS idx_page_views_utm_source   ON page_views(utm_source);

CREATE TABLE IF NOT EXISTS leads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  email            TEXT    NOT NULL,
  phone            TEXT    NOT NULL,
  method           TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  ip               TEXT,
  user_agent       TEXT,
  created_at       TEXT    NOT NULL,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  utm_term         TEXT,
  utm_content      TEXT,
  updated_at       TEXT,
  funnel           TEXT,
  utm_page         TEXT,
  product          TEXT DEFAULT 'curso',
  phone_norm       TEXT,
  meta_campaign_id TEXT,
  meta_adset_id    TEXT,
  meta_ad_id       TEXT,
  fbclid           TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_created_at   ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_funnel       ON leads(funnel);
CREATE INDEX IF NOT EXISTS idx_leads_ip           ON leads(ip);
CREATE INDEX IF NOT EXISTS idx_leads_meta_ad      ON leads(meta_ad_id);
CREATE INDEX IF NOT EXISTS idx_leads_method       ON leads(method);
CREATE INDEX IF NOT EXISTS idx_leads_phone_norm   ON leads(phone_norm);
CREATE INDEX IF NOT EXISTS idx_leads_product      ON leads(product);
CREATE INDEX IF NOT EXISTS idx_leads_updated_at   ON leads(updated_at);
CREATE INDEX IF NOT EXISTS idx_leads_utm_campaign ON leads(utm_campaign);
CREATE INDEX IF NOT EXISTS idx_leads_utm_page     ON leads(utm_page);
CREATE INDEX IF NOT EXISTS idx_leads_utm_source   ON leads(utm_source);

-- Analytics in-page por seção/CTA (/secoes).
CREATE TABLE IF NOT EXISTS section_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_uuid         TEXT NOT NULL,
  page                 TEXT NOT NULL,
  funnel               TEXT,
  section              TEXT,              -- NULL em eventos de página
  event_type           TEXT NOT NULL,     -- section_view | cta_click | max_scroll | time_on_page
  cta                  TEXT,              -- só em cta_click
  last_visible_section TEXT,              -- seção visível no momento do clique
  value                REAL,              -- % de scroll ou segundos
  ip                   TEXT,
  user_agent           TEXT,
  device               TEXT,              -- mobile | tablet | desktop
  utm_source           TEXT,
  utm_medium           TEXT,
  utm_campaign         TEXT,
  utm_term             TEXT,
  utm_content          TEXT,
  ts_ms                INTEGER NOT NULL,  -- epoch ms no cliente
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_se_created_at   ON section_events(created_at);
CREATE INDEX IF NOT EXISTS idx_se_page_section ON section_events(page, section);
CREATE INDEX IF NOT EXISTS idx_se_page_type    ON section_events(page, event_type);
CREATE INDEX IF NOT EXISTS idx_se_session      ON section_events(session_uuid);

-- ============================================================
-- Ofertas e checkout
-- ============================================================

-- Cada linha vira /checkout/<code>.
CREATE TABLE IF NOT EXISTS offers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT    NOT NULL UNIQUE,
  name               TEXT    NOT NULL,
  description        TEXT,
  anchor_price_cents INTEGER NOT NULL DEFAULT 0,
  sale_price_cents   INTEGER NOT NULL,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  out_of_stock       INTEGER NOT NULL DEFAULT 0,   -- 1 = checkout simulado, sem cobrança
  thanks_url         TEXT,
  meta_pixel_id      TEXT,                          -- sobrescreve META_PIXEL_ID
  meta_capi_token    TEXT,                          -- sobrescreve META_PIXEL_ACCESS_TOKEN
  email_enabled      INTEGER NOT NULL DEFAULT 0 CHECK (email_enabled IN (0, 1)),
  email_subject      TEXT,
  email_body         TEXT,                          -- aceita {{nome}} e {{produto}}
  email_access_url   TEXT                           -- vira botão no e-mail, se preenchido
);
CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(is_active);
CREATE INDEX IF NOT EXISTS idx_offers_code   ON offers(code);

CREATE TABLE IF NOT EXISTS order_bumps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id    INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_order_bumps_offer ON order_bumps(offer_id, is_active, position, id);

-- Comportamento da visita ao checkout (/checkout-analytics).
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_uuid        TEXT    NOT NULL UNIQUE,
  session_uuid      TEXT,
  offer_code        TEXT,
  lead_id           INTEGER,
  funnel            TEXT,
  utm_page          TEXT,
  last_stage        TEXT    NOT NULL DEFAULT 'opened',
  method            TEXT,
  bump_selected     INTEGER NOT NULL DEFAULT 0,
  last_event        TEXT    NOT NULL DEFAULT 'opened',
  visible_ms        INTEGER NOT NULL DEFAULT 0,
  hidden_ms         INTEGER NOT NULL DEFAULT 0,
  background_count  INTEGER NOT NULL DEFAULT 0,
  resume_count      INTEGER NOT NULL DEFAULT 0,
  validation_errors INTEGER NOT NULL DEFAULT 0,
  payment_attempts  INTEGER NOT NULL DEFAULT 0,
  ip                TEXT,
  user_agent        TEXT,
  started_at        TEXT    NOT NULL,
  last_seen_at      TEXT    NOT NULL,
  hidden_at         TEXT,
  resumed_at        TEXT,
  exited_at         TEXT,
  is_bot            INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  bot_reason        TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_last_seen ON checkout_sessions(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_lead      ON checkout_sessions(lead_id);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_offer     ON checkout_sessions(offer_code);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_session   ON checkout_sessions(session_uuid);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_started   ON checkout_sessions(started_at);

-- ============================================================
-- Pagamentos (Mercado Pago)
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id       INTEGER NOT NULL,
  lead_id        INTEGER,
  mp_payment_id  TEXT    NOT NULL UNIQUE,
  external_ref   TEXT    NOT NULL UNIQUE,
  method         TEXT    NOT NULL DEFAULT 'pix',
  status         TEXT    NOT NULL DEFAULT 'pending',
  amount_cents   INTEGER NOT NULL,
  payer_email    TEXT,
  payer_name     TEXT,
  payer_phone    TEXT,
  qr_code        TEXT,
  qr_code_base64 TEXT,
  ticket_url     TEXT,
  expires_at     TEXT,
  approved_at    TEXT,
  notified_at    TEXT,
  meta_event_id  TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  FOREIGN KEY (offer_id) REFERENCES offers(id),
  FOREIGN KEY (lead_id)  REFERENCES leads(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_created  ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_external ON payments(external_ref);
CREATE INDEX IF NOT EXISTS idx_payments_lead     ON payments(lead_id);
CREATE INDEX IF NOT EXISTS idx_payments_mp_id    ON payments(mp_payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_offer    ON payments(offer_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);

CREATE TABLE IF NOT EXISTS payment_order_bumps (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id           INTEGER NOT NULL,
  order_bump_id        INTEGER,
  name_snapshot        TEXT    NOT NULL,
  description_snapshot TEXT,
  price_cents          INTEGER NOT NULL CHECK (price_cents > 0),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  FOREIGN KEY (payment_id)    REFERENCES payments(id) ON DELETE CASCADE,
  FOREIGN KEY (order_bump_id) REFERENCES order_bumps(id) ON DELETE SET NULL,
  UNIQUE (payment_id, order_bump_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_order_bumps_payment ON payment_order_bumps(payment_id);

CREATE TABLE IF NOT EXISTS payment_errors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER,
  offer_id     INTEGER,
  stage        TEXT    NOT NULL,
  error_code   TEXT,
  error_detail TEXT,
  funnel       TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_term     TEXT,
  utm_content  TEXT,
  utm_page     TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL,
  FOREIGN KEY (lead_id)  REFERENCES leads(id),
  FOREIGN KEY (offer_id) REFERENCES offers(id)
);
CREATE INDEX IF NOT EXISTS idx_payment_errors_created_at   ON payment_errors(created_at);
CREATE INDEX IF NOT EXISTS idx_payment_errors_funnel       ON payment_errors(funnel);
CREATE INDEX IF NOT EXISTS idx_payment_errors_ip           ON payment_errors(ip);
CREATE INDEX IF NOT EXISTS idx_payment_errors_lead         ON payment_errors(lead_id);
CREATE INDEX IF NOT EXISTS idx_payment_errors_stage        ON payment_errors(stage);
CREATE INDEX IF NOT EXISTS idx_payment_errors_utm_campaign ON payment_errors(utm_campaign);

CREATE TABLE IF NOT EXISTS payment_refunds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id    INTEGER NOT NULL UNIQUE,
  lead_id       INTEGER,
  mp_payment_id TEXT    NOT NULL UNIQUE,
  operation_id  TEXT    NOT NULL,
  refund_id     TEXT,
  status        TEXT    NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','in_process','approved','failed')),
  amount_cents  INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error_code    TEXT,
  error_detail  TEXT,
  requested_at  TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  completed_at  TEXT,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (lead_id)    REFERENCES leads(id)
);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_lead   ON payment_refunds(lead_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_status ON payment_refunds(status);

-- Fonte única de compras (lida por /funil, /meta e /vendas).
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway           TEXT    NOT NULL CHECK (gateway IN ('mercadopago')),
  gateway_txn_id    TEXT,
  gateway_order_ref TEXT,
  status            TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','refunded','chargeback','cancelled','rejected','expired')),
  method            TEXT    CHECK (method IN ('pix','card','boleto')),
  amount_cents      INTEGER NOT NULL DEFAULT 0,
  paid_amount_cents INTEGER,
  installments      INTEGER,
  lead_id           INTEGER,
  offer_id          INTEGER,
  funnel_id         INTEGER,
  utm_source        TEXT,
  utm_medium        TEXT,
  utm_campaign      TEXT,
  utm_term          TEXT,
  utm_content       TEXT,
  utm_page          TEXT,
  meta_campaign_id  TEXT,
  meta_adset_id     TEXT,
  meta_ad_id        TEXT,
  fbclid            TEXT,
  payer_name        TEXT,
  payer_email       TEXT,
  payer_phone       TEXT,
  meta_event_id     TEXT,   -- gerado uma vez, nunca sobrescrito
  side_effects_at   TEXT,   -- NULL = efeitos pós-compra (CAPI, e-mail) ainda não disparados
  raw_event_id      INTEGER,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  approved_at       TEXT,
  refunded_at       TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  ip                TEXT,
  FOREIGN KEY (lead_id)   REFERENCES leads(id),
  FOREIGN KEY (offer_id)  REFERENCES offers(id),
  FOREIGN KEY (funnel_id) REFERENCES funnels(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_approved  ON orders(approved_at);
CREATE INDEX IF NOT EXISTS idx_orders_created   ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_funnel    ON orders(funnel_id);
CREATE INDEX IF NOT EXISTS idx_orders_ip        ON orders(ip);
CREATE INDEX IF NOT EXISTS idx_orders_lead      ON orders(lead_id);
CREATE INDEX IF NOT EXISTS idx_orders_meta_ad   ON orders(meta_ad_id);
CREATE INDEX IF NOT EXISTS idx_orders_meta_camp ON orders(meta_campaign_id);
CREATE INDEX IF NOT EXISTS idx_orders_offer     ON orders(offer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_mp
  ON orders(gateway_txn_id) WHERE gateway = 'mercadopago' AND gateway_txn_id IS NOT NULL;

-- Log de cada efeito pós-compra (CAPI, e-mail), incluindo reenvios manuais.
CREATE TABLE IF NOT EXISTS purchase_dispatches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER,
  lead_id      INTEGER,
  offer_id     INTEGER,
  channel      TEXT NOT NULL,                 -- 'capi' | 'email'
  status       TEXT NOT NULL,                 -- 'sent' | 'delivered' | 'queued' | 'failed' | 'skipped'
  triggered_by TEXT NOT NULL DEFAULT 'auto',  -- 'auto' (na compra) | 'manual' (reenvio pelo dashboard)
  destination  TEXT,
  message      TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now', '-3 hours') || '-03:00'),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (lead_id)  REFERENCES leads(id),
  FOREIGN KEY (offer_id) REFERENCES offers(id)
);
CREATE INDEX IF NOT EXISTS idx_dispatches_created ON purchase_dispatches(created_at);
CREATE INDEX IF NOT EXISTS idx_dispatches_lead    ON purchase_dispatches(lead_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_order   ON purchase_dispatches(order_id);

-- Compras de ofertas fora de estoque (checkout simulado, sem cobrança).
CREATE TABLE IF NOT EXISTS fake_checkout_purchases (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id             INTEGER NOT NULL REFERENCES leads(id),
  offer_id            INTEGER NOT NULL REFERENCES offers(id),
  offer_code          TEXT NOT NULL,
  offer_name_snapshot TEXT NOT NULL,
  method              TEXT NOT NULL CHECK (method IN ('pix', 'card')),
  base_price_cents    INTEGER NOT NULL CHECK (base_price_cents >= 0),
  total_cents         INTEGER NOT NULL CHECK (total_cents >= base_price_cents),
  bumps_json          TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  UNIQUE(lead_id, offer_code)
);
