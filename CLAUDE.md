# funil-cloudflare

Funil de vendas completo rodando em **um único Cloudflare Worker** com **um banco D1**:

- **Páginas de venda** com Meta Pixel + Conversions API (CAPI) deduplicados, UTMs repassadas até a compra e analytics por seção (leitura, rolagem, cliques).
- **Checkout** em `/checkout/<oferta>` com Mercado Pago (Pix e cartão), order bumps, e-mail de confirmação e eventos Lead/Purchase enviados pelo servidor.
- **Dashboard** com Basic Auth: Leads, Vendas (reembolso, histórico, CSV), Funil, Meta Ads, Ofertas, Seções, Diagnóstico do checkout e o Painel de links.
- **Skills do Claude Code** para criar páginas/ofertas/funis e subir campanhas na Meta com o padrão de UTM.

Este arquivo é o manual completo: setup do zero, arquitetura e convenções. Ele é lido pelo Claude Code, então você também pode simplesmente pedir "faça o setup do projeto" e seguir as instruções.

---

## 1. Setup do zero

### 1.1 O que você precisa

| Item | Para quê | Obrigatório |
|---|---|---|
| Conta Cloudflare com um domínio ativo nela | Hospedar o site, o banco e o domínio | Sim |
| Node.js 20 ou superior | Rodar os scripts de setup | Sim |
| Conta Mercado Pago (vendedor) | Receber Pix e cartão | Sim |
| Meta Pixel + token da Conversions API | Rastrear conversões | Sim |
| Token da Marketing API da Meta | Tela `/meta` e criação de campanhas | Não |
| Domínio cadastrado no Cloudflare Email Sending | E-mail de confirmação pós-compra | Não |

### 1.2 Instalar

```bash
git clone <url-deste-repositorio> funil
cd funil
npm install
cp .env.example .env
```

Todas as configurações ficam no **`.env`** na raiz do projeto. Ele nunca vai para o git.

### 1.3 Token da Cloudflare (link com as permissões prontas)

Abra o link abaixo logado na Cloudflare. Ele abre a tela de criação de token com as permissões já marcadas:

https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_routes%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22ssl_and_certificates%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=funil-cloudflare

Confira se aparecem estas permissões:

| Escopo | Permissão | Nível |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| Zone | Workers Routes | Edit |
| Zone | Zone | Read |
| Zone | DNS | Edit |
| Zone | SSL and Certificates | Edit |

Observações:

- Se as listas aparecerem vazias, clique em **Edit token** e volte. É um bug conhecido da tela da Cloudflare.
- Se for usar o e-mail de confirmação, adicione manualmente **Account → Email Sending → Edit**.
- **Recomendado:** em **Account Resources** e **Zone Resources**, troque "All accounts"/"All zones" pela sua conta e pelo seu domínio. O link abre com acesso a tudo só para funcionar em qualquer conta.

Crie o token e cole no `.env`:

```
CLOUDFLARE_API_TOKEN=cole_o_token_aqui
```

### 1.4 Preencher o `.env`

| Variável | Onde conseguir |
|---|---|
| `APP_HOSTNAME` | O endereço do site, por exemplo `vendas.seudominio.com.br`. O domínio precisa estar na sua conta Cloudflare. O setup cria o DNS e o certificado sozinho. |
| `BRAND_NAME` | Nome da sua empresa (aparece nos títulos do dashboard e do checkout). |
| `STATEMENT_DESCRIPTOR` | Nome na fatura do cartão: até 13 letras ou números, sem acento. |
| `GUARANTEE_DAYS` | Dias de garantia mostrados no checkout. `0` esconde o selo. |
| `MP_PUBLIC_KEY`, `MP_ACCESS_TOKEN` | Mercado Pago → [Suas integrações](https://www.mercadopago.com.br/developers/panel/app) → sua aplicação → Credenciais de produção. Para testar, use as credenciais de teste. |
| `META_PIXEL_ID` | Gerenciador de Eventos → seu Pixel → Configurações. |
| `META_PIXEL_ACCESS_TOKEN` | Gerenciador de Eventos → Pixel → Configurações → Conversions API → **Gerar token de acesso**. |
| `META_TEST_EVENT_CODE` | Opcional. Gerenciador de Eventos → **Eventos de teste**. Enquanto preenchido, os eventos do servidor aparecem nessa aba sem contar como reais. Apague depois de validar. |
| `META_ACCESS_TOKEN` | Opcional. Business Manager → Usuários do sistema → gerar token com `ads_read` e `ads_management`. Alimenta a tela `/meta` e as skills de campanha. |
| `META_AD_ACCOUNT_ID` | Opcional. ID da conta de anúncios, formato `act_123...`. Para várias contas use `META_AD_ACCOUNT_IDS=act_1,act_2`. |
| `EMAIL_FROM`, `CLOUDFLARE_EMAIL_API_TOKEN` | Opcional. Veja a seção 1.7. |
| `DASH_USER`, `DASH_PASS` | Login do dashboard. Deixe `DASH_PASS` vazio para o setup gerar uma senha forte e gravar no `.env`. |

### 1.5 Rodar o setup

```bash
npm run setup -- --dry-run   # só valida o .env e o token, não cria nada
npm run setup -- --demo      # setup completo + oferta e funil de exemplo
```

O setup faz, em ordem:

1. Valida o `.env` e o token (sem nunca exibir valores).
2. Localiza o domínio na sua conta.
3. Cria o banco D1 (ou reaproveita o que ele mesmo criou antes).
4. Gera o `wrangler.toml` a partir do `wrangler.toml.example`.
5. Aplica o schema (`migrations/`) e os dados iniciais (`seed/`).
6. Roda os testes automatizados.
7. Publica o Worker no seu domínio (DNS e certificado automáticos).
8. Envia os segredos (`wrangler secret bulk`).
9. Roda o teste de fumaça (`npm run smoke`).

Pode rodar de novo quando quiser: ele é idempotente. Por segurança, ele se recusa a:

- usar um Worker ou banco com o mesmo nome que não tenha sido criado por ele (`--force` e `--adopt` liberam);
- publicar num endereço que já aponta para outro Worker ou outro servidor (`--force` libera);
- aceitar `DASH_PASS` com menos de 16 caracteres.

Rodar o setup sem `--debug-approve` desliga a aprovação de teste (`/api/mp/_debug_approve`) se ela estiver ligada.

Ao final ele mostra:

- **Site:** `https://APP_HOSTNAME`
- **Painel:** `https://APP_HOSTNAME/painel` (usuário `DASH_USER`, senha `DASH_PASS` do `.env`)

### 1.6 Mercado Pago: webhook

Não é preciso configurar nada no painel do Mercado Pago. Cada pagamento é criado com `notification_url = https://APP_HOSTNAME/api/mp/webhook`, e o checkout também consulta o status a cada 2 segundos enquanto o cliente está na tela.

### 1.7 E-mail de confirmação (opcional)

1. Cloudflare → **Compute → Email Service → Email Sending → Onboard Domain** e escolha seu domínio. A Cloudflare cria os registros SPF, DKIM e DMARC.
2. Crie um token só com **Account → Email Sending → Edit** e coloque em `CLOUDFLARE_EMAIL_API_TOKEN`.
3. Defina `EMAIL_FROM`, por exemplo `contato@seudominio.com.br`.
4. Rode `npm run setup` de novo.
5. Em `/ofertas`, edite a oferta e marque **Enviar e-mail**. Assunto e corpo aceitam `{{nome}}` e `{{produto}}`; o link de acesso vira um botão.

Cada envio fica registrado em **Vendas → Ver disparos**, com opção de reenviar.

### 1.8 Desenvolvimento local

```bash
npm run dev
```

Sobe tudo em `http://localhost:8787` com banco local (`.wrangler/`), schema e dados de exemplo. Nada é enviado para a Cloudflare. Login do painel: `admin` / `dev` (ou o que estiver no `.env`).

### 1.9 Comandos

| Comando | O que faz |
|---|---|
| `npm run setup` | Setup completo (idempotente). |
| `npm run deploy` | Testes + migrations pendentes + publicação. Use depois de qualquer mudança. |
| `npm run dev` | Ambiente local completo. |
| `npm run migrate` | Aplica migrations pendentes (`--local` para o banco local). |
| `npm run smoke` | Verifica a instância publicada. |
| `npm test` | Testes unitários e de integração. |
| `npm run test:ui` | Testes de interface (Playwright, exige `npx playwright install chromium`). |
| `npm run scan` | Varredura de segredos com gitleaks (rode antes de todo push). |

---

## 2. Arquitetura

```
Navegador ──► Worker (src/index.js: roteador)
                ├─ dashboard/  /leads /vendas /funil /meta /painel /ofertas /secoes /checkout-analytics /dashboard/api/*
                ├─ checkout/   /checkout/<oferta>  /api/checkout*  /api/mp/*
                └─ site/       páginas, /obrigado, /api/meta-event, /api/section-event, /api/lead, /static/*
                         │
                         └──► D1 (um banco) · Mercado Pago · Meta Graph API · Cloudflare Email Sending
```

- **Um Worker, três módulos.** `src/routes.mjs` mapeia prefixos de caminho para módulos; vence o prefixo mais longo (ex.: `/checkout-analytics` é do dashboard, `/checkout/...` é do checkout). Cada módulo tem seu próprio `export default { fetch }`.
- **Isolamento de segredos.** `src/index.js` entrega a cada módulo só as variáveis de que ele precisa: o dashboard não enxerga a credencial do Mercado Pago. Reembolsos e reenvio de e-mail passam do dashboard para o checkout por `env.CHECKOUT_SERVICE`, um atalho interno; os caminhos `/internal/*` nunca são públicos.
- **Mesma origem.** Páginas, checkout e APIs ficam no mesmo domínio. É isso que mantém o cookie de sessão (`tx_session_uuid`), o repasse de UTMs e o diagnóstico do checkout funcionando juntos.
- **Datas no fuso de Brasília** (`-03:00`), moeda BRL e textos em pt-BR, já que Pix e Mercado Pago são do Brasil.

### 2.1 Pastas

| Pasta | Conteúdo |
|---|---|
| `src/` | Roteador e tabela de rotas. |
| `site/` | Servidor das páginas (`pages.config.mjs` é o registro das páginas) e APIs de rastreamento. |
| `checkout/` | Checkout, Mercado Pago, CAPI do checkout, efeitos pós-compra, reembolso. |
| `dashboard/` | Telas do dashboard (HTML) e a API `/dashboard/api/*`. |
| `shared/` | Código comum: page views, CAPI, detecção de bots, pedidos, order bumps, e-mail. |
| `public/` | Arquivos estáticos: `checkout.html`, `obrigado.html`, `static/lp-tracking.js`, `pages/<slug>/v<N>.html`. |
| `migrations/` | Schema do D1. Para mudar o banco, crie `0002_*.sql` e rode `npm run deploy`. |
| `seed/` | Dados iniciais (menu do painel) e exemplo (`--demo`). |
| `scripts/` | Setup, deploy, dev, smoke, varredura. |
| `tests/` | `unit/`, `integration/` (Worker inteiro em Miniflare), `ui/` (Playwright), `e2e/` (contra a instância publicada). |
| `.claude/skills/` | Skills do Claude Code (seção 5). |

### 2.2 Tabelas principais

| Tabela | Uso |
|---|---|
| `page_views` | Cada visita (página, funil, UTMs, sessão, `utm_page`, bot ou não). |
| `leads` | Pessoas que preencheram dados no checkout ou num formulário; `status` evolui `nome → email → telefone → escolheu_metodo → pix_gerado → comprou`. |
| `offers` / `order_bumps` | Produtos vendidos em `/checkout/<code>`. |
| `payments` / `orders` | Pagamentos do Mercado Pago; `orders` é a fonte única de compras para os relatórios. |
| `purchase_dispatches` | Log dos efeitos pós-compra (CAPI, e-mail), inclusive reenvios. |
| `funnels` / `funnel_steps` | Configuração do que aparece em `/funil`. |
| `section_events` | Analytics por seção das páginas (`/secoes`). |
| `checkout_sessions` | Comportamento no checkout (`/checkout-analytics`). |
| `painel_links` | Itens do `/painel`. |
| `settings` | `blocked_ips` (IPs ignorados nas estatísticas). |

---

## 3. Rastreamento: Pixel, CAPI e UTMs

O fluxo completo de uma visita paga:

1. O anúncio leva para `https://APP_HOSTNAME/<pagina>` com as UTMs da Meta (seção 5.2).
2. O Worker registra o `page_view` (UTMs, funil, sessão) e injeta no HTML o Pixel, `window.__LP` e `/static/lp-tracking.js`.
3. `lp-tracking.js` dispara `PageView` e `ViewContent` no navegador **e** no servidor (`/api/meta-event`) com o mesmo `eventID`, então a Meta deduplica.
4. No clique em um CTA, dispara `InitiateCheckout` e leva para `/checkout/<oferta>` repassando **todos** os parâmetros da URL, mais `funnel`, `utm_page` e `utm_content_cta` (qual botão foi clicado).
5. O checkout guarda UTMs e IDs da Meta no lead e no pedido. `Lead` e `Purchase` saem do servidor (com e-mail e telefone em hash) e do navegador, deduplicados.
6. Após o pagamento, `/obrigado` recebe os mesmos parâmetros.

Pixel por oferta: em `/ofertas` cada oferta pode ter Pixel e token próprios; sem isso, vale `META_PIXEL_ID` / `META_PIXEL_ACCESS_TOKEN`.

---

## 4. Criar uma página nova

Use a skill `/nova-pagina` (ela faz tudo abaixo). Manualmente:

1. Copie `public/pages/_template/index.html` para `public/pages/<slug>/v1.html` e escreva o texto. Mantenha:
   - `data-section="<slug-da-secao>"` em cada bloco (kebab-case, até 60 caracteres). É isso que alimenta `/secoes`.
   - `<a href="#checkout" data-cta="<id>">` em cada botão de compra.
2. Registre em `site/pages.config.mjs`:
   ```js
   'meu-produto': { funnel: 'meu-produto', offer: 'meu-produto', variants: { 1: '/pages/meu-produto/v1.html' }, split: [1] },
   ```
   Para teste A/B, adicione `2: '/pages/meu-produto/v2.html'` e `split: [1, 2]`. A variante fica fixa por visitante (cookie) e `?v=2` força uma delas.
3. Crie a oferta em `/ofertas` (o `code` vira `/checkout/<code>` e não pode mudar depois).
4. Crie o funil em `/funil` → **Gerenciar funis**, com o mesmo slug.
5. `npm run deploy`.

**Regra:** sempre crie o funil antes de subir a campanha. Campanhas diferentes na mesma página reutilizam o mesmo funil e se diferenciam por `utm_campaign`.

Boas práticas para as páginas: headline primeiro e em destaque, pensar no celular antes do desktop, blocos curtos com marcadores em vez de parágrafos longos, fonte sem serifa e contraste forte.

---

## 5. Skills do Claude Code

Ficam em `.claude/skills/` e são carregadas automaticamente quando você abre o projeto no Claude Code.

| Skill | Use para |
|---|---|
| `/nova-pagina` | Criar página + oferta + funil + link no painel e publicar. |
| `/subir-campanha` | Criar campanha de vendas na Meta (tudo pausado até você confirmar) com o padrão de UTM. |
| `/meta-ads` | Operações gerais na Marketing API (listar, pausar, duplicar, subir criativos). |
| `/teste-checkout` | Teste ponta a ponta do checkout na instância publicada. |
| `/analise-campanha` | Relatório de uma campanha cruzando Meta Ads e o banco. |

### 5.1 Variáveis usadas pelas skills

`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_PIXEL_ID`, `META_PAGE_ID`, `META_IG_USER_ID`, `CAMPAIGN_PREFIX` (padrão `CP`, gera `CP1`, `CP2`...), `DASH_USER`/`DASH_PASS`, `APP_HOSTNAME`, `D1_NAME`.

### 5.2 Padrão de UTM nos anúncios da Meta

O link de destino fica limpo (`https://APP_HOSTNAME/<pagina>`) e os parâmetros vão no campo **Parâmetros de URL** (`url_tags`) do criativo:

```
utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{adset.name}}&utm_term={{ad.name}}&meta_campaign_id={{campaign.id}}&meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}}
```

Esses valores chegam a `page_views`, `leads` e `orders`, e é por eles que `/funil` e `/meta` cruzam gasto com vendas.

---

## 6. Segurança

- **Nunca** exiba credenciais: nada de `cat .env`, `echo $TOKEN`, `printenv`. Carregar é seguro: `set -a; . ./.env; set +a`.
- Em `curl`, use a variável: `-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"`. Não use `-v`.
- Não cole tokens em prompts do Claude Code: o histórico fica gravado em disco. Se isso acontecer, revogue o token.
- `.env`, `.dev.vars`, `wrangler.toml` e `.instance.json` estão no `.gitignore`.
- Antes de todo push: `npm run scan`. Para rodar automaticamente: `git config core.hooksPath .githooks`.
- O dashboard recusa acesso (503) enquanto `DASH_PASS` não estiver configurada.
- `/api/mp/_debug_approve` (aprovação forçada para testes) só funciona se `DEBUG_APPROVE_TOKEN` existir; o setup só cria esse token com `--debug-approve`. Não use em produção com dinheiro real.
- Para IPs da sua equipe não sujarem as estatísticas: dashboard → engrenagem → **Editar IPs/blocos bloqueados**.
- O dashboard recusa escrita vinda de outro site (proteção contra CSRF) e não devolve o token CAPI das ofertas para o navegador.
- Rotas `/internal/*` (reembolso e reenvio de e-mail) só respondem a chamadas do próprio Worker.
- As APIs públicas de eventos (`/api/meta-event`, `/api/checkout-event`) só aceitam os eventos que as páginas realmente enviam e calculam valor e moeda no servidor. Mesmo assim, recomendamos uma regra de limite de requisições: Cloudflare → seu domínio → **Security → WAF → Rate limiting rules**, para os caminhos `/api/` com, por exemplo, 60 requisições por minuto por IP.
- `META_TEST_EVENT_CODE` manda **todos** os eventos do servidor para a aba de teste da Meta, inclusive compras reais. O setup e o deploy avisam enquanto ele estiver preenchido; apague-o depois de validar.

---

## 7. Solução de problemas

| Sintoma | Causa provável |
|---|---|
| Setup diz que o domínio não está na conta | Adicione o domínio na Cloudflare e espere ficar "Active". |
| `Authentication error` no deploy | Token sem alguma permissão da seção 1.3. Crie outro pelo link. |
| Site responde erro de certificado logo após o setup | O certificado do domínio leva alguns minutos. Rode `npm run smoke` depois. |
| Dashboard responde 503 | `DASH_PASS` não foi enviada. Rode `npm run setup` de novo. |
| Eventos não aparecem no Gerenciador de Eventos | Confira `META_PIXEL_ACCESS_TOKEN`; use `META_TEST_EVENT_CODE` e a aba Eventos de teste. Veja os disparos em **Vendas → Ver disparos**. |
| E-mail com status `skipped` | Falta `EMAIL_FROM` ou `CLOUDFLARE_EMAIL_API_TOKEN`, ou a oferta está com e-mail desligado. |
| Minhas visitas aparecem nas estatísticas | Bloqueie seu IP na engrenagem do dashboard. |
