const express = require("express");
const ytDlp = require("yt-dlp-exec");
const axios = require("axios");
const http = require("http");
const https = require("https");

const axiosInstance = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
  timeout: 20000,
});

// cache de URL de áudio por vídeo
const streamCache = new Map();
const STREAM_TTL = 1000 * 60 * 10; // 10 minutos

function getCachedStream(url) {
  const item = streamCache.get(url);
  if (!item) return null;
  if (Date.now() > item.expire) {
    streamCache.delete(url);
    return null;
  }
  return item.audioUrl;
}

const MAX_CACHE = 100; // limite de itens no cache

function setCachedStream(url, audioUrl) {
  // 🔥 remove o mais antigo se passar do limite
  if (streamCache.size >= MAX_CACHE) {
    const firstKey = streamCache.keys().next().value;
    streamCache.delete(firstKey);
  }

  streamCache.set(url, {
    audioUrl,
    expire: Date.now() + STREAM_TTL,
  });
}

const searchCache = new Map();
const SEARCH_TTL = 1000 * 60 * 5; // 5 minutos

const router = express.Router();

router.get("/", (req, res) => {
  return res.send("Olá");
});

router.get("/download", async (req, res) => {
  try {
    const { url, title } = req.query;

    if (!url) {
      return res.status(400).json({
        error: "URL não fornecida",
      });
    }

    const filename = title ? `${title}.mp3` : "music.mp3";

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );

    const stream = ytDlp.exec(url, {
      extractAudio: true,
      audioFormat: "mp3",

      // 🔥 adiciona metadata
      embedMetadata: true,

      // 🔥 adiciona capa
      embedThumbnail: true,

      // baixa thumbnail
      writeThumbnail: true,

      // envia para stdout
      output: "-",

      noWarnings: true,
      noCallHome: true,
    });

    stream.stdout.pipe(res);

    stream.stderr.on("data", (data) => {
      console.log(data.toString());
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      error: "Erro no download",
    });
  }
});

router.post("/info", async (req, res) => {
  const { url } = req.body;

  try {
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
    });

    res.json({
      id: info.id,
      title: info.title,
      artist: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail,
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar vídeo" });
  }
});

router.post("/search", async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: "É necessário informar o query" });
  }

  const cached = searchCache.get(query);

  if (cached && Date.now() < cached.expire) {
    return res.json(cached.data);
  }

  try {
    const results = await ytDlp(`ytsearch5:${query}`, {
      dumpSingleJson: true,
      noWarnings: true,

      // ❌ removido (deprecated)
      // noCallHome: true,

      // 🔥 evita bloqueio
      extractorArgs: "youtube:player_client=android",

      addHeader: [
        "user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "accept-language: en-US,en;q=0.9",
      ],
    });

    const tracks = results.entries
      .filter(Boolean) // 🔥 remove nulls (muito importante)
      .map((item) => ({
        id: item.id,
        title: item.title,
        artist: item.uploader,
        duration: item.duration,
        thumbnail: item.thumbnail,
        url: item.webpage_url,
      }));

    searchCache.set(query, {
      data: tracks,
      expire: Date.now() + SEARCH_TTL,
    });

    res.json(tracks);

  } catch (err) {
    console.error("Erro na busca principal:", err.message);

    // 🔥 FALLBACK (ULTRA IMPORTANTE)
    try {
      const fallback = await ytDlp(`ytsearch3:${query}`, {
        dumpSingleJson: true,
        noWarnings: true,
      });

      const tracks = fallback.entries
        .filter(Boolean)
        .map((item) => ({
          id: item.id,
          title: item.title,
          artist: item.uploader,
          duration: item.duration,
          thumbnail: item.thumbnail,
          url: item.webpage_url,
        }));

      return res.json(tracks);

    } catch (err2) {
      console.error("Erro no fallback:", err2.message);

      return res.status(500).json({
        error: "Erro ao buscar músicas",
      });
    }
  }
});

// Rota de STREAMING (para o player de áudio — sem Content-Disposition: attachment)
router.get("/stream", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: "URL não fornecida" });
    }

    const range = req.headers.range;

    // 🔥 1. TENTA PEGAR DO CACHE
    let audioUrl = getCachedStream(url);

    if (!audioUrl) {
      try {
        const result = await ytDlp.exec(url, {
          format: "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
          getUrl: true,
          noWarnings: true,

          extractorArgs: "youtube:player_client=android",

          addHeader: [
            "user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "accept-language: en-US,en;q=0.9",
          ],
        });

        audioUrl = result.stdout.trim();

        // 🔥 salva no cache
        setCachedStream(url, audioUrl);

      } catch (err) {
        console.log("Fallback ativado...");

        // 🔥 fallback extremo
        const result = await ytDlp.exec(url, {
          format: "best",
          getUrl: true,
        });

        audioUrl = result.stdout.trim();
        setCachedStream(url, audioUrl);
      }
    }

    // 🔥 2. STREAM COM KEEP-ALIVE (mais rápido)
    const audioStream = await axiosInstance({
      method: "GET",
      url: audioUrl,
      responseType: "stream",
      headers: range ? { Range: range } : {},
    });

    // 🔥 detecta tipo real (melhor que fixo)
    const contentType =
      audioStream.headers["content-type"] || "audio/mpeg";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");

    if (audioStream.headers["content-length"]) {
      res.setHeader("Content-Length", audioStream.headers["content-length"]);
    }

    if (audioStream.headers["content-range"]) {
      res.setHeader("Content-Range", audioStream.headers["content-range"]);
      res.status(206);
    }

    // 🔥 resposta mais rápida (buffer flush)
    res.flushHeaders?.();

    audioStream.data.pipe(res);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Erro ao streamar áudio",
      details: err.stderr || err.message,
    });
  }
});

module.exports = router;
