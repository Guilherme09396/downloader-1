const axios = require("axios");

// =======================
// 1. PEGAR CLIENT_ID DINÂMICO
// =======================
async function getClientId() {
  const { data: html } = await axios.get("https://soundcloud.com");

  // pega arquivos JS do site
  const jsUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/.+?\.js)"/g)]
    .map(match => match[1]);

  for (const url of jsUrls) {
    try {
      const { data: js } = await axios.get(url);

      const match = js.match(/client_id:"([a-zA-Z0-9]+)"/);

      if (match) {
        console.log("✅ client_id encontrado:", match[1]);
        return match[1];
      }
    } catch { }
  }

  throw new Error("Não conseguiu obter client_id");
}

// =======================
// 2. SEARCH
// =======================
async function search(query, client_id) {
  const { data } = await axios.get(
    "https://api-v2.soundcloud.com/search/tracks",
    {
      params: {
        q: query,
        client_id,
        limit: 5,
      },
    }
  );

  return data.collection;
}

// =======================
// 3. PEGAR STREAM
// =======================
async function getStream(track, client_id) {
  const transcoding = track.media?.transcodings?.find(
    t => t.format.protocol === "progressive"
  );

  if (!transcoding) {
    throw new Error("Sem áudio disponível");
  }

  const { data } = await axios.get(transcoding.url, {
    params: { client_id },
  });

  return data.url;
}

// =======================
// TESTE
// =======================
(async () => {
  try {
    console.log("🔎 Pegando client_id...");

    const client_id = await getClientId();

    console.log("🔎 Buscando música...");

    const tracks = await search("ceu azul", client_id);

    const first = tracks[0];

    console.log("🎵", first.title);

    const streamUrl = await getStream(first, client_id);

    console.log("🎧 STREAM:");
    console.log(streamUrl);

  } catch (err) {
    console.error("❌ Erro:", err.message);
  }
})();