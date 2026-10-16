import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { creativeDestinationUrl, creativeImageHashes } from "../../dashboard/src/meta-creative.mjs";

test("extracts original-image hashes from static and dynamic creatives", () => {
  assert.deepEqual(creativeImageHashes({
    image_hash: "11111111111111111111111111111111",
    asset_feed_spec: {
      images: [
        { hash: "22222222222222222222222222222222" },
        { hash: "11111111111111111111111111111111" },
      ],
    },
  }), ["11111111111111111111111111111111", "22222222222222222222222222222222"]);

  assert.deepEqual(creativeImageHashes({
    asset_feed_spec: { images: [{ hash: "invalido" }] },
  }), []);
});

test("extracts destinations from standard image and video creatives", () => {
  assert.equal(creativeDestinationUrl({
    object_story_spec: { link_data: { link: "https://example.com/imagem" } },
  }), "https://example.com/imagem");

  assert.equal(creativeDestinationUrl({
    object_story_spec: {
      video_data: { call_to_action: { value: { link: "https://example.com/video" } } },
    },
  }), "https://example.com/video");
});

test("extracts the website destination from a dynamic creative", () => {
  assert.equal(creativeDestinationUrl({
    asset_feed_spec: {
      link_urls: [{ display_url: "example.com", website_url: "https://example.com/dinamico" }],
    },
  }), "https://example.com/dinamico");
});

test("rejects unsafe or malformed destination URLs", () => {
  assert.equal(creativeDestinationUrl({ link_url: "javascript:alert(1)" }), null);
  assert.equal(creativeDestinationUrl({ link_url: "pagina-sem-protocolo" }), null);
});

test("Meta page renders a destination icon beside the creative thumbnail", async () => {
  const [worker, page] = await Promise.all([
    readFile(new URL("../../dashboard/src/worker.js", import.meta.url), "utf8"),
    readFile(new URL("../../dashboard/src/meta.html", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /object_story_spec,asset_feed_spec/);
  assert.match(worker, /destination_url: creativeDestinationUrl/);
  assert.match(worker, /original_image_urls: creativeImageHashes/);
  assert.match(page, /class="creative-destination-link"/);
  assert.match(page, /Abrir página de destino do criativo/);
});

test("Meta page opens a readable, viewport-bounded creative preview", async () => {
  const page = await readFile(new URL("../../dashboard/src/meta.html", import.meta.url), "utf8");

  assert.match(page, /width: min\(480px, calc\(100vw - 32px\)\)/);
  assert.match(page, /max-height: min\(560px, calc\(100vh - 64px\)\)/);
});
