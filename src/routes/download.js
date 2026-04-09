const express = require("express");
const axios = require("axios");

const router = express.Router();

// =======================
// CACHE
// =======================
const streamCache = new Map();
let CLIENT_ID_CACHE = null;

// =======================
// HELPERS
// =======================

async function resolveClientId() {
  if (process.env.SOUNDCLOUD_CLIENT_ID) return process.env.SOUNDCLOUD_CLIENT_ID;
  if (CLIENT_ID_CACHE) return CLIENT_ID_CACHE;

  const { data: html } = await axios.get("https://soundcloud.com");

  const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/.*?\.js)"/g)]
    .map(m => m[1]);

  for (const url of scripts) {
    try {
      const { data: js } = await axios.get(url);
      const match = js.match(/client_id:"([a-zA-Z0-9]+)"/);
      if (match) {
        CLIENT_ID_CACHE = match[1];
        console.log("🔥 SoundCloud client_id carregado:", CLIENT_ID_CACHE);
        return CLIENT_ID_CACHE;
      }
    } catch (_) { }
  }

  throw new Error("Erro ao obter client_id");
}

function normalizeTrack(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.user?.username || "Unknown",
    duration: Math.floor(t.duration / 1000),
    thumbnail: t.artwork_url || t.user?.avatar_url,
    url: t.permalink_url,
    _raw: t,
  };
}

// =======================
// SEARCH
// =======================
router.post("/search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "query obrigatória" });

    const clientId = await resolveClientId();

    const { data } = await axios.get("https://api-v2.soundcloud.com/search/tracks", {
      params: { q: query, client_id: clientId, limit: 20 },
    });

    res.json(data.collection.map(normalizeTrack));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro search soundcloud" });
  }
});

// =======================
// INFO
// =======================
router.post("/info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url obrigatória" });

    const clientId = await resolveClientId();

    const { data } = await axios.get("https://api-v2.soundcloud.com/resolve", {
      params: { url, client_id: clientId },
    });

    res.json(normalizeTrack(data));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro info" });
  }
});

// =======================
// STREAM
// =======================
router.get("/stream", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "url obrigatória" });

    const clientId = await resolveClientId();

    let audioUrl = streamCache.get(url);

    if (!audioUrl) {
      const { data } = await axios.get("https://api-v2.soundcloud.com/resolve", {
        params: { url, client_id: clientId },
      });

      if (!data.media?.transcodings) {
        return res.status(404).json({ error: "stream não encontrado" });
      }

      const progressive = data.media.transcodings.find(
        t => t.format.protocol === "progressive"
      );

      if (!progressive) return res.status(404).json({ error: "sem stream progressivo" });

      const streamRes = await axios.get(progressive.url, {
        params: { client_id: clientId },
      });

      audioUrl = streamRes.data.url;
      streamCache.set(url, audioUrl);
    }

    const response = await axios({
      method: "GET",
      url: audioUrl,
      responseType: "stream",
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    res.setHeader("Content-Type", "audio/mpeg");
    response.data.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro stream" });
  }
});

// =======================
// DOWNLOAD
// =======================
router.get("/download", async (req, res) => {
  try {
    const { url, title } = req.query;
    if (!url) return res.status(400).json({ error: "url obrigatória" });

    const clientId = await resolveClientId();

    const { data } = await axios.get("https://api-v2.soundcloud.com/resolve", {
      params: { url, client_id: clientId },
    });

    const progressive = data.media.transcodings.find(
      t => t.format.protocol === "progressive"
    );

    if (!progressive) return res.status(404).json({ error: "sem stream progressivo" });

    const streamRes = await axios.get(progressive.url, {
      params: { client_id: clientId },
    });

    const audioUrl = streamRes.data.url;

    const fileRes = await axios({
      method: "GET",
      url: audioUrl,
      responseType: "stream",
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${(title || data.title).replace(/[^a-z0-9]/gi, "_")}.mp3"`
    );

    fileRes.data.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro download" });
  }
});

// =======================
// OFFLINE URL (retorna URL direta do áudio)
// =======================
router.get("/offline-url", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "url obrigatória" });

    const clientId = await resolveClientId();

    const { data } = await axios.get("https://api-v2.soundcloud.com/resolve", {
      params: { url, client_id: clientId },
    });

    if (!data.media?.transcodings) {
      return res.status(404).json({ error: "stream não encontrado" });
    }

    const progressive = data.media.transcodings.find(
      t => t.format.protocol === "progressive"
    );

    if (!progressive) return res.status(404).json({ error: "sem stream progressivo" });

    const streamRes = await axios.get(progressive.url, {
      params: { client_id: clientId },
    });

    res.json({ audioUrl: streamRes.data.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro offline-url" });
  }
});

module.exports = router;