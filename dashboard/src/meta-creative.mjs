function httpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function imageHash(value) {
  if (typeof value !== "string") return null;
  const hash = value.trim();
  return /^[a-f0-9]{32}$/i.test(hash) ? hash : null;
}

// Imagens de criativos dinâmicos ficam em asset_feed_spec e a API de anúncios
// devolve apenas uma miniatura renderizada de 64 px. Reúne os hashes dos assets
// originais para que o worker possa resolver URLs em alta resolução via
// /adimages, sem expor o token da Meta ao navegador.
export function creativeImageHashes(creative) {
  if (!creative || typeof creative !== "object") return [];

  const story = creative.object_story_spec || {};
  const assets = Array.isArray(creative.asset_feed_spec?.images)
    ? creative.asset_feed_spec.images
    : [];
  const candidates = [
    creative.image_hash,
    story.link_data?.image_hash,
    story.video_data?.image_hash,
    ...assets.map((image) => image?.hash),
  ];

  return [...new Set(candidates.map(imageHash).filter(Boolean))];
}

// A Meta guarda o destino em campos diferentes conforme o formato do criativo
// (imagem/link, vídeo ou criativo dinâmico). Devolve o primeiro destino web válido.
export function creativeDestinationUrl(creative) {
  if (!creative || typeof creative !== "object") return null;

  const story = creative.object_story_spec || {};
  const linkData = story.link_data || {};
  const videoData = story.video_data || {};
  const templateData = story.template_data || {};
  const feedLinks = Array.isArray(creative.asset_feed_spec?.link_urls)
    ? creative.asset_feed_spec.link_urls
    : [];

  const candidates = [
    creative.link_url,
    creative.object_url,
    linkData.link,
    linkData.call_to_action?.value?.link,
    videoData.call_to_action?.value?.link,
    templateData.link,
    templateData.call_to_action?.value?.link,
    creative.call_to_action?.value?.link,
    ...feedLinks.flatMap((item) => [item?.website_url, item?.carousel_see_more_url]),
  ];

  for (const candidate of candidates) {
    const url = httpUrl(candidate);
    if (url) return url;
  }
  return null;
}
