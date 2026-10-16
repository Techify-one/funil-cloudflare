-- Oferta, order bump e funil de exemplo (opcional: npm run setup -- --demo).

INSERT OR IGNORE INTO offers (code, name, description, anchor_price_cents, sale_price_cents, is_active, thanks_url,
                              email_enabled, email_subject, email_body)
VALUES ('produto-exemplo', 'Produto Exemplo', 'Oferta de demonstração do funil', 19700, 9700, 1, '/obrigado',
        0, 'Sua compra de {{produto}} foi confirmada',
        'Olá, {{nome}}!\n\nRecebemos o pagamento de {{produto}}. Obrigado pela confiança.');

INSERT INTO order_bumps (offer_id, name, description, price_cents, is_active, position)
SELECT id, 'Bônus Exemplo', 'Material extra para acelerar seus resultados', 2700, 1, 1
FROM offers
WHERE code = 'produto-exemplo'
  AND NOT EXISTS (SELECT 1 FROM order_bumps b WHERE b.offer_id = offers.id);

INSERT OR IGNORE INTO funnels (slug, name, is_default) VALUES ('exemplo', 'Funil Exemplo', 1);

INSERT OR IGNORE INTO funnel_steps (funnel_id, position, key, label, source, match_value)
SELECT id, 1, 'visitas_pagina', 'Visitas na página', 'page_view', 'exemplo' FROM funnels WHERE slug = 'exemplo';
INSERT OR IGNORE INTO funnel_steps (funnel_id, position, key, label, source, match_value)
SELECT id, 2, 'visitas_checkout', 'Visitas no checkout', 'page_view', 'checkout' FROM funnels WHERE slug = 'exemplo';
INSERT OR IGNORE INTO funnel_steps (funnel_id, position, key, label, source, match_value)
SELECT id, 3, 'preencheu_dados', 'Preencheu dados', 'lead_status', 'telefone,escolheu_metodo,pix_gerado,comprou' FROM funnels WHERE slug = 'exemplo';
INSERT OR IGNORE INTO funnel_steps (funnel_id, position, key, label, source, match_value)
SELECT id, 4, 'escolheu_metodo', 'Escolheu método de pagamento', 'lead_status', 'escolheu_metodo,pix_gerado,comprou' FROM funnels WHERE slug = 'exemplo';
INSERT OR IGNORE INTO funnel_steps (funnel_id, position, key, label, source, match_value)
SELECT id, 5, 'gerou_pix', 'Gerou PIX', 'lead_status', 'pix_gerado,comprou' FROM funnels WHERE slug = 'exemplo';
INSERT OR IGNORE INTO funnel_steps (funnel_id, position, key, label, source, match_value)
SELECT id, 6, 'comprou', 'Comprou', 'order', 'approved' FROM funnels WHERE slug = 'exemplo';
