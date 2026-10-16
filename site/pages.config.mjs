// Registro das páginas de venda servidas pelo site.
//
// Cada chave é o slug da página e vira a rota pública /<slug> (com ou sem barra
// no final). Campos:
//   funnel    slug do funil gravado em page_views.funnel (padrão: o próprio slug).
//   offer     code da oferta em `offers`; o botão leva para /checkout/<offer>.
//   variants  { N: '/pages/<slug>/vN.html' }: arquivos HTML dentro de public/.
//   split     variantes sorteadas para quem chega sem cookie. Repetir um número
//             aumenta o peso dele (ex.: [1, 1, 2] = 2/3 para a v1).
// Opcionais:
//   source    identificador enviado ao /api/meta-event (padrão: o slug).
//   content   content_name dos eventos do Pixel (padrão: nome da oferta no banco).
//   value     valor dos eventos do Pixel em reais (padrão: preço da oferta no banco).
//   pixelId   Pixel desta página (padrão: pixel da oferta, depois META_PIXEL_ID).
//
// ?v=N na URL força uma variante (preview) e o visitante fica nela pelo cookie
// lp_<slug>_v. O slug não pode colidir com rotas do checkout ou do dashboard.

export const PAGES = {
  exemplo: {
    funnel: 'exemplo',
    offer: 'produto-exemplo',
    variants: { 1: '/pages/exemplo/v1.html' },
    split: [1],
  },
};
