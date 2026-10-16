# funil-cloudflare

Funil de vendas completo em um único Cloudflare Worker: páginas com Meta Pixel + Conversions API e UTMs repassadas até a compra, checkout com Mercado Pago (Pix e cartão), e-mail de confirmação, e um dashboard de leads, vendas, funil, Meta Ads, ofertas e analytics por seção.

```bash
npm install
cp .env.example .env      # preencha (veja CLAUDE.md)
npm run setup -- --demo   # cria banco, publica e configura tudo na Cloudflare
```

Para só ver funcionando no seu computador, sem criar contas: `npm install && cp .env.example .env && npm run dev` e abra http://localhost:8787 (painel em `/painel`, usuário `admin`, senha `dev`).

O manual completo (token da Cloudflare com link pronto, chaves necessárias, arquitetura, criação de páginas e campanhas) está no [CLAUDE.md](CLAUDE.md).

Licença: MIT.
