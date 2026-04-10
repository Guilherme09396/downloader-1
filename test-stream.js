// test-stream.js
// node test-stream.js
const axios = require("axios");

// =======================
// SOUNDCLOUD
// =======================
async function getSoundCloudClientId() {
  const { data: html } = await axios.get("https://soundcloud.com");
  const jsUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/.+?\.js)"/g)]
    .map(m => m[1]);

  for (const url of jsUrls) {
    try {
      const { data: js } = await axios.get(url);
      const match = js.match(/client_id:"([a-zA-Z0-9]+)"/);
      if (match) return match[1];
    } catch { }
  }
  throw new Error("Não conseguiu obter client_id do SoundCloud");
}

async function soundcloudSearch(query, client_id) {
  const { data } = await axios.get("https://api-v2.soundcloud.com/search/tracks", {
    params: { q: query, client_id, limit: 5 },
  });
  return data.collection;
}

async function soundcloudStream(track, client_id) {
  const transcoding = track.media?.transcodings?.find(
    t => t.format.protocol === "progressive"
  );
  if (!transcoding) throw new Error("Sem áudio progressivo no SoundCloud");
  const { data } = await axios.get(transcoding.url, { params: { client_id } });
  return data.url;
}

// =======================
// INVIDIOUS (ROBUSTO)
// =======================
const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.private.coffee",
  "https://yewtu.be",
  "https://vid.puffyan.us",
  "https://inv.tux.pizza"
];

const BASE_HEADERS = {
  "user-agent": "Mozilla/5.0",
  "accept-language": "en-US,en;q=0.9",
};

// Função helper com retry
async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, {
        timeout: 7000,
        headers: BASE_HEADERS,
        ...options,
      });
    } catch (err) {
      if (i === retries - 1) throw err;
    }
  }
}

// =======================
// SEARCH
// =======================
async function invidiousSearch(query) {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const { data } = await fetchWithRetry(`${base}/api/v1/search`, {
        params: {
          q: query,
          type: "video",
          region: "BR"
        },
      });

      if (Array.isArray(data) && data.length > 0) {
        console.log(`✅ Invidious SEARCH OK: ${base}`);
        return data;
      }

    } catch (err) {
      console.warn(`⚠️ SEARCH falhou em ${base}`);
    }
  }

  throw new Error("Nenhuma instância respondeu (search)");
}

// =======================
// STREAM
// =======================
async function invidiousStream(videoId) {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const { data } = await fetchWithRetry(`${base}/api/v1/videos/${videoId}`);

      // 🔥 PRIORIDADE: áudio-only
      const audio = data.adaptiveFormats
        ?.filter(f => f.type?.includes("audio"))
        ?.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (audio?.url) {
        console.log(`✅ AUDIO OK: ${base}`);
        return audio.url;
      }

      // 🔥 fallback: qualquer formato com áudio
      const withAudio = data.formatStreams
        ?.find(f => f.url && f.mimeType?.includes("audio"));

      if (withAudio?.url) {
        console.log(`✅ FALLBACK OK: ${base}`);
        return withAudio.url;
      }

    } catch (err) {
      console.warn(`⚠️ STREAM falhou em ${base}`);
    }
  }

  throw new Error("Nenhuma instância conseguiu stream");
}

// =======================
// TESTE
// =======================
(async () => {
  const QUERY = "ceu azul";

  console.log("\n======= TESTE SOUNDCLOUD =======");
  try {
    console.log("🔎 Pegando client_id...");
    const client_id = await getSoundCloudClientId();
    console.log("✅ client_id:", client_id);

    console.log("🔎 Buscando:", QUERY);
    const tracks = await soundcloudSearch(QUERY, client_id);
    const first = tracks[0];
    console.log("🎵 Resultado:", first.title, "-", first.user?.username);

    const streamUrl = await soundcloudStream(first, client_id);
    console.log("🎧 Stream URL (SoundCloud):", streamUrl.substring(0, 80) + "...");
  } catch (err) {
    console.error("❌ SoundCloud falhou:", err.message);
  }

  console.log("\n======= TESTE INVIDIOUS (YouTube) =======");
  try {
    console.log("🔎 Buscando:", QUERY);
    const videos = await invidiousSearch(QUERY);
    const first = videos[0];
    console.log("🎵 Resultado:", first.title, "-", first.author);
    console.log("🆔 Video ID:", first.videoId);

    const streamUrl = await invidiousStream(first.videoId);
    console.log("🎧 Stream URL (Invidious):", streamUrl.substring(0, 80) + "...");
  } catch (err) {
    console.error("❌ Invidious falhou:", err.message);
  }
})();