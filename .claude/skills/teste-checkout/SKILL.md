---
name: teste-checkout
description: Roda o teste ponta a ponta do checkout contra a instância publicada (Playwright) - abre /checkout/<oferta>, preenche o formulário como uma pessoa, gera o Pix, força a aprovação pelo endpoint de debug, confere eventos do Pixel na rede (InitiateCheckout, Lead, Purchase com eventID), banco D1 (pagamento, pedido, lead, disparos CAPI e e-mail) e a página de obrigado, e apaga os dados de teste. Use depois de qualquer deploy que mexa no checkout. Triggers "testa o checkout", "teste e2e do checkout", "valida o fluxo de pagamento", "/teste-checkout".
---

# Teste E2E do checkout

## Resumo

```bash
node tests/e2e/checkout.e2e.mjs
```

Roda em cerca de 40 segundos e apaga os dados que criou. Saída esperada no final: `=== TODAS AS CHECAGENS PASSARAM ===`. Qualquer `✗` é regressão: **não libere tráfego** até corrigir.

Todos os caminhos são relativos à raiz do repositório.

## Segurança (credenciais)

- O teste lê o `.env` da raiz sozinho e **nunca** imprime valores.
- Para rodar comandos manuais, carregue com `set -a; . ./.env; set +a`. **Nunca** `cat .env`, `echo $DEBUG_APPROVE_TOKEN`, `printenv` ou `curl -v`.
- `DEBUG_APPROVE_TOKEN` marca um Pix pendente como pago **no sistema** (não move dinheiro). Se vazar, alguém consegue gerar "vendas" falsas e disparar CAPI/e-mails. Não cole o token em chat, issue ou commit.

## O que o teste cobre

| # | Etapa | Checagem |
|---|---|---|
| 1 | Abre `https://$APP_HOSTNAME/checkout/<oferta>?funnel=...&utm_*=...&meta_*_id=...` | `#name` aparece |
| 2 | Preenche `#name`, `#email`, `#phone` (eventos reais do DOM) | |
| 3 | Clica em `#tab-pix` e `#btn-pay-pix` | `POST /api/mp/create-pix` com `ok`, `payment_id`, `lead_id`; `#qr-code-text` visível |
| 4 | `POST /api/mp/_debug_approve` com cabeçalho `x-debug-token: $DEBUG_APPROVE_TOKEN` | `ok: true` (simula o webhook do Mercado Pago) |
| 5 | Polling do checkout | navegador vai para a página de obrigado (`?pid=<payment_id>`) |
| 6 | Requisições do Pixel (`facebook.com/tr`) | `InitiateCheckout`, `Lead` e `Purchase`, todos com `eventID`; Lead com `lead-<id>` (mesmo da CAPI) |
| 7 | D1 via `npx wrangler d1 execute $D1_NAME --remote` | `payments.status=approved`; `orders.status=approved` com UTMs, `meta_ad_id` e funil; eventID do Purchase no navegador igual a `orders.meta_event_id`; lead com funil/UTMs e status esperado; `purchase_dispatches` com `capi=sent` e, se a oferta tem e-mail ligado, `email` enviado; `orders.side_effects_at` preenchido |
| 8 | Página de obrigado | título renderizado |
| limpeza | DELETE no D1 | disparos, pedido, pagamento, lead, sessões e visitas do teste |

## Pré-requisitos

1. Instância publicada (`npm run setup` já rodou) e oferta de teste ativa. O padrão é a oferta `produto-exemplo` e o funil `exemplo`, criados por `npm run setup -- --demo`.
2. Endpoint de debug habilitado: `npm run setup -- --debug-approve` gera `DEBUG_APPROVE_TOKEN`, grava no `.env` e envia como segredo do Worker. Sem o segredo no Worker, o endpoint responde `503 disabled`.
3. `.env` com `APP_HOSTNAME`, `D1_NAME`, `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` (usados pelo `wrangler` para consultar e limpar o banco).
4. Chromium do Playwright: `npx playwright install chromium` (uma vez por máquina).
5. Credenciais reais do Mercado Pago no Worker: o Pix é criado de verdade (fica pendente, não é cobrado e expira sozinho).

## Variáveis opcionais

| Variável | Padrão | Para quê |
|---|---|---|
| `E2E_BASE_URL` | `https://$APP_HOSTNAME` | Apontar para outro ambiente |
| `E2E_OFFER` | `produto-exemplo` | Testar outra oferta (`code` da tabela `offers`) |
| `E2E_FUNNEL` | `exemplo` | Funil usado na atribuição |
| `E2E_EMAIL` | `e2e-<ts>@example.com` | E-mail real para validar a entrega do e-mail de confirmação |
| `E2E_REQUIRE_EMAIL` | `false` | `true` falha se a oferta não tiver e-mail pós-compra ligado |
| `E2E_LEAD_STATUS` | `comprou,pix_gerado` | Status aceitos para o lead após a compra (a compra oficial fica em `orders`) |
| `E2E_HEADLESS` | `true` | `false` abre o navegador para depurar |
| `E2E_CLEANUP` | `true` | `false` mantém os dados para inspecionar |

Exemplo para uma página nova criada com a skill `nova-pagina`:

```bash
E2E_OFFER=<slug> E2E_FUNNEL=<slug> node tests/e2e/checkout.e2e.mjs
```

## Quando rodar

Sempre que mexer em:

- `checkout/src/index.js` (criação de Pix/cartão, `processPaymentUpdate`, efeitos pós-compra, CAPI, e-mail, status);
- `public/checkout.html` (formulário, fluxo do Pix, Pixel, redirecionamento);
- `shared/` usado pelo checkout (`orders.js`, `utils.js`, e-mail, order bumps);
- `wrangler.toml.example`, segredos ou variáveis do Worker;
- uma oferta nova ou alterada (preço, e-mail, Pixel próprio).

Fluxo padrão depois de mudar o checkout:

```bash
npm run deploy
node tests/e2e/checkout.e2e.mjs
```

Passou: deploy validado. Falhou: leia a mensagem, decida entre reverter (`git revert` + `npm run deploy`) ou corrigir e repetir.

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `create-pix` com `invalid_email` ou `payer.email must be a valid email` | E-mail com domínio inválido (`.test`, `.invalid`) | Use `@example.com` ou um e-mail real em `E2E_EMAIL` |
| `create-pix` com `offer_not_found` | Oferta inexistente ou inativa | Confira `E2E_OFFER` em `/ofertas` |
| `debug-approve` 503 | Worker sem o segredo `DEBUG_APPROVE_TOKEN` | `npm run setup -- --debug-approve` |
| `debug-approve` 403 | Token do `.env` diferente do segredo do Worker | Rode o setup de novo para reenviar os segredos |
| Não redireciona | Polling de `/api/mp/status` ou `thanks_url` da oferta quebrados | `E2E_HEADLESS=false` e veja o console do navegador |
| Pixel sem `Purchase` | Redirect falhou antes do disparo ou `META_PIXEL_ID` vazio | Confira o `META_PIXEL_ID` e o fluxo em `public/checkout.html` |
| eventID do navegador diferente de `orders.meta_event_id` | Deduplicação Pixel/CAPI quebrada | Revise a geração do `meta_event_id` no checkout |
| `capi` com status `failed` | `META_PIXEL_ACCESS_TOKEN` ausente/inválido | Veja o erro em **Vendas → Ver disparos**; gere outro token no Gerenciador de Eventos |
| `email` com `skipped` | Falta `EMAIL_FROM`/`CLOUDFLARE_EMAIL_API_TOKEN` | Ver seção de e-mail do `CLAUDE.md` |
| `wrangler d1 execute falhou` | `D1_NAME` errado ou token sem permissão de D1 | Confira o `.env` (sem imprimir valores) |

## Endpoint `/api/mp/_debug_approve`

- Só existe se o segredo `DEBUG_APPROVE_TOKEN` estiver no Worker; sem ele responde `503`. Token errado: `403`.
- Só aprova pagamentos que já existem no banco (criados por `/api/mp/create-pix`).
- Para trocar o token: apague `DEBUG_APPROVE_TOKEN` do `.env` e rode `npm run setup -- --debug-approve` (gera outro e reenvia).
- Em produção com dinheiro real, prefira manter o endpoint desligado e só habilitar durante janelas de teste.

## Limitação: cartão de crédito

O fluxo de cartão não é testado automaticamente (exige os campos seguros do Mercado Pago e cartão de teste). Valide manualmente com as credenciais de teste do Mercado Pago e um cartão de teste da documentação dele.

## Estendendo o teste

Edite `tests/e2e/checkout.e2e.mjs`. Padrão: `step('N', '...')` para rotular a etapa e `assert(condição, 'mensagem')` para checar; os erros se acumulam e o código de saída é 1 se houver qualquer falha. Consultas ao banco usam `d1(sql)` (wrangler remoto). Lembre de incluir na limpeza qualquer linha nova que o teste passar a criar.
