// node test-invidious.js

const axios = require("axios");

// lista de instâncias (fallback automático)
const INSTANCES = [
  "https://invidious.snopyta.org",
  "https://inv.nadeko.net",
  "https://invidious.privacydev.net",
  "https://yewtu.be"
];

// tenta buscar em várias instâncias
async function searchInvidious(query) {
  for (const base of INSTANCES) {
    try {
      console.log(`🔍 Tentando: ${base}`);

      const { data } = await axios.get(
        `${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
        { timeout: 8000 }
      );

      if (data && data.length > 0) {
        console.log(`✅ Funcionou com: ${base}`);
        return data;
      }
    } catch (err) {
      console.log(`❌ Falhou: ${base}`);
    }
  }

  throw new Error("Nenhuma instância funcionou");
}

// pegar stream de áudio
async function getAudio(videoId) {
  for (const base of INSTANCES) {
    try {
      const { data } = await axios.get(
        `${base}/api/v1/videos/${videoId}`,
        { timeout: 8000 }
      );

      const audio = data.adaptiveFormats.find(f =>
        f.type.includes("audio")
      );

      if (audio) {
        return {
          url: audio.url,
          bitrate: audio.bitrate,
        };
      }
    } catch (err) { }
  }

  return null;
}

// ================= TESTE =================

(async () => {
  try {
    const query = "poesia 6";

    const results = await searchInvidious(query);

    console.log("\n🎵 RESULTADOS:");
    const first = results[0];

    console.log({
      title: first.title,
      videoId: first.videoId,
      author: first.author,
    });

    const audio = await getAudio(first.videoId);

    console.log("\n🔊 AUDIO:");
    console.log(audio);

    console.log("\n▶️ URL para teste:");
    console.log(audio?.url);

  } catch (err) {
    console.error("Erro:", err.message);
  }
})();