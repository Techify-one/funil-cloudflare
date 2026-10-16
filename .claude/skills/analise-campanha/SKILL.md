---
name: analise-campanha
description: Faz a análise completa de uma campanha da Meta Ads deste projeto - coleta automaticamente Meta Marketing API + banco D1 (page_views, leads, orders, disparos, diagnóstico do checkout) + API do funil, baixa e transcreve os criativos, identifica o gargalo principal e gera um RELATORIO.md com recomendações priorizadas. Use quando o usuário disser "analisa a campanha CP<N>", "como está a CP<N>?", "ver números da campanha", "análise da campanha" ou invocar /analise-campanha.
---

# Análise de campanha (Meta Ads + banco do funil)

Cruza o que a Meta reporta (gasto, cliques, eventos) com o que o funil registrou de verdade no banco (visitas, leads, checkout, vendas aprovadas) e aponta onde o dinheiro está sendo perdido. Todos os caminhos são relativos à raiz do repositório.

## Segurança (credenciais)

- O `coleta.sh` carrega o `.env` com `set -a; . ./.env; set +a` e **nunca** imprime token ou senha.
- Não rode `cat .env`, `echo $META_ACCESS_TOKEN`, `printenv` ou `curl -v`. Não cole tokens no chat.
- A pasta `analises/` contém dados pessoais de leads (nome, e-mail, telefone). **Não versione**: confira se `analises/` está no `.gitignore` antes do primeiro commit e adicione se não estiver.

## Quando ativar

Frases como "analisa a CP<N>", "como está a campanha CP<N>", "números da CP<N>", "/analise-campanha <N>".

Extraia o nome ou número da campanha. Só número vira `${CAMPAIGN_PREFIX:-CP}<número>`. Se o usuário disser "a última" ou "a que está rodando", liste as campanhas ativas (skill `meta-ads`) e pergunte qual.

## Passo 1: coleta automatizada

```bash
.claude/skills/analise-campanha/coleta.sh <N>       # ou: coleta.sh CP<N>
```

Variáveis usadas do `.env`: `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_API_VERSION` (opcional), `CAMPAIGN_PREFIX` (opcional), `D1_NAME`, `APP_HOSTNAME`, `DASH_USER`/`DASH_PASS` (opcional, para a API do funil) e as credenciais da Cloudflare usadas pelo `wrangler`.

Saída em `analises/<campanha>/`:

| Arquivo | Conteúdo |
|---|---|
| `dados/campaign_info.json` | Status, objetivo, janela, orçamento |
| `dados/adsets.json` | Conjuntos (otimização, `promoted_object`, público, aprendizado) |
| `dados/ads.json`, `dados/creatives_full.json` | Anúncios, copy, `url_tags`, `asset_feed_spec` |
| `dados/insights_{campaign,adset,ad}.json` | Métricas da vida toda por nível |
| `dados/insights_daily.json` | Gasto e eventos por dia |
| `criativos/ad_<nome>.jpg` + `dados/creatives_downloaded.json` | Imagens dos criativos (miniatura em vídeos) |
| `dados/d1_pageviews_overview.json`, `_daily`, `_by_ad` | Visitas reais por página, dia e anúncio (`utm_term`), sem bots |
| `dados/funnel_slug.txt`, `dados/d1_funnel_steps.json` | Funil dominante da campanha e suas etapas |
| `dados/d1_funnel_unique_visitors.json` | Visitantes únicos: só página, página + checkout |
| `dados/d1_leads.json`, `d1_leads_by_status.json` | Leads da campanha e distribuição por etapa |
| `dados/d1_orders.json`, `d1_sales_by_ad.json` | Pedidos e vendas aprovadas por anúncio (`meta_ad_id`, ou `utm_term`) |
| `dados/d1_dispatches.json` | Disparos pós-compra (CAPI, e-mail) por status |
| `dados/d1_payment_errors.json`, `d1_checkout_stages.json` | Erros de pagamento e onde as pessoas param no checkout |
| `dados/d1_compare_campaigns.json` | Outras campanhas no mesmo funil |
| `dados/d1_offers.json` | Ofertas ativas (preço, e-mail pós-compra, página de obrigado) |
| `dados/dashboard_funnel.json` | Funil do dashboard filtrado pela campanha (90 dias) |

O script é idempotente (sobrescreve tudo). Falhas pontuais no D1 viram `[]` com aviso, sem interromper.

## Passo 2: ler os dados (nesta ordem)

1. `campaign_info.json`: janela, status, objetivo.
2. `adsets.json`: otimização e evento (`promoted_object.custom_event_type`), aprendizado.
3. `insights_campaign.json` e `insights_ad.json` (filtre anúncios com gasto > 0).
4. `creatives_full.json`: copy e `url_tags` de cada anúncio. `url_tags` diferente do padrão do projeto quebra a atribuição (ver skill `subir-campanha`).
5. `d1_funnel_unique_visitors.json`, `d1_pageviews_by_ad.json`: o funil real.
6. `d1_leads_by_status.json`, `d1_checkout_stages.json`, `d1_payment_errors.json`: onde o checkout perde gente.
7. `d1_orders.json`, `d1_sales_by_ad.json`: receita confirmada (só `status='approved'` conta).
8. `d1_dispatches.json`: CAPI `failed` significa que a Meta não está recebendo as compras do servidor.
9. `d1_compare_campaigns.json`, `d1_offers.json`.

## Passo 3: ver e transcrever os criativos

Abra cada `criativos/ad_<nome>.jpg` com a ferramenta de leitura de imagem e anote: headline visual, textos de apoio e selos, visual dominante, CTA, preço/prazo/data escritos na imagem (importante para detectar incoerência com a página).

Salve tudo em `analises/<campanha>/transcricoes/criativos.md` (uma seção por anúncio: copy do post, texto da imagem, métricas e observações).

Depois de transcrever, **apague as imagens**:

```bash
rm -rf analises/<campanha>/criativos/
```

Só mantenha se o usuário pedir ("não apaga as imagens").

## Passo 4: ver a página de destino

Descubra a página pelo `d1_pageviews_overview.json` (`page`/`utm_page`) e pelo registro em `site/pages.config.mjs`. O HTML fica em `public/pages/<slug>/v<N>.html` (cada variante de teste A/B tem `utm_page = /<slug>-v<N>`).

Confira:
- Preço, garantia, prazos e promessa batem com o criativo e com `d1_offers.json`.
- CTAs com `href="#checkout"` e `data-cta` (sem isso o clique não vai para o checkout com as UTMs).
- Nenhum Pixel colado à mão no HTML (o worker injeta; duplicar gera eventos em dobro).
- Para ver o que está no ar: abra `https://$APP_HOSTNAME/<slug>` (o `/secoes` mostra rolagem, seções vistas e CTA clicado por variante).

## Passo 5: cruzar e achar o gargalo

Use visitantes únicos do banco (não visitas brutas: recarregar a página infla o número).

- Visitantes da página → visitantes do checkout (página → checkout)
- Checkout → leads com dados (`telefone` ou além)
- Leads → `pix_gerado` / tentativa de pagamento
- → vendas aprovadas em `orders`

Compare com a Meta:
- `landing_page_view` da Meta × visitantes da página no banco (devem ser parecidos; muito menos no banco indica página lenta, redirecionamento ou bloqueio).
- `initiate_checkout` da Meta × visitantes do checkout.
- `purchase` da Meta × vendas aprovadas (a Meta tende a mostrar menos pela janela de atribuição; muito mais indica Pixel disparando errado).

O gargalo é a **maior queda absoluta**, não a maior porcentagem.

### Sinais de alerta obrigatórios

- 🚩 Preço, prazo ou promessa diferente entre criativo, página e oferta.
- 🚩 `url_tags` ausente ou fora do padrão (vendas não são atribuídas à campanha).
- 🚩 Campanha otimizando `PURCHASE` com 0 compras registradas (algoritmo sem sinal).
- 🚩 Disparos CAPI com `failed` em `d1_dispatches.json`.
- 🚩 Oferta com e-mail pós-compra desligado quando o produto depende de link de acesso.
- 🚩 Anúncio com gasto relevante (ex.: mais que um ticket) e 0 vendas.
- 🚩 ROAS menor que 1 (prejuízo) ou CPA maior que o ticket médio.
- 🚩 Muitos `payment_errors` ou abandono concentrado numa etapa do checkout.

## Passo 6: escrever `analises/<campanha>/RELATORIO.md`

```markdown
# Análise <campanha> (funil <slug>)

**Período:** <início> a <fim>
**Status:** <effective_status>

## Resumo: onde está o problema principal
> Uma frase clara com o gargalo número 1.

3 a 5 bullets com os fatos (números do JSON, trechos de código com caminho e linha, links markdown para os arquivos).

## Números consolidados
- Tabela: gasto, receita (banco), ROAS Meta × banco, CPA, custo por lead, ticket médio, resultado líquido.
- Funil em texto (impressões → cliques → página → checkout → lead → compra) com a perda de cada etapa.
- Tabela por anúncio (status, gasto, vendas, ROAS), destacando o melhor e o desperdício.

## Comparativo
Outras campanhas no mesmo funil: melhor, pior ou igual em página → compra.

## Outros gargalos
Lista numerada: cada sinal de alerta encontrado + uma frase de correção.

## Recomendações priorizadas
- **Urgente** (parar prejuízo agora)
- **Antes da próxima campanha** (correções estruturais)
- **Próximos testes** (ângulos, criativos, variantes de página)

## Arquivos desta análise
Árvore do que está em `analises/<campanha>/`.
```

Diretrizes:
- **Concreto**: toda afirmação apoiada em número dos JSONs ou em trecho de código com caminho e linha.
- **Direto**: ROAS 0,3 é "prejuízo de R$ X", não "desempenho abaixo do esperado".
- Valores em `R$ X,XX` (vírgula decimal), tabelas em markdown.
- Recomendação diz **o que mudar e onde** (ex.: "trocar o preço em `public/pages/<slug>/v1.html` na seção `oferta` para bater com a oferta"), nunca "melhorar a página".
- Sem maquiar resultado ruim.

## Passo 7: resposta ao usuário

Resumo de 5 a 10 linhas: gasto, receita e ROAS; o gargalo principal numa frase; 2 ou 3 ações urgentes; caminho do `RELATORIO.md`. Não cole o relatório inteiro no chat.

## Notas

- Rodar duas vezes para a mesma campanha é seguro: os dados são sobrescritos.
- `Campanha '<nome>' não encontrada`: o nome na Meta pode estar diferente (minúsculas, espaço). Liste as campanhas e rode com o nome exato.
- Erro `190` da Meta: token expirado; peça para gerar outro e atualizar o `.env`.
- Banco vazio para a campanha: tráfego ainda não chegou, ou os anúncios estão sem o padrão de `url_tags`. Relate isso sem inventar análise.
- Esta skill é só **diagnóstico**: não rode deploy nem altere código ou campanhas sem pedido explícito.
