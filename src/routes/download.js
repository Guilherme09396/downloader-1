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

const streamCache = new Map();
const STREAM_TTL = 1000 * 60 * 10;

const MAX_CACHE_SIZE = 100;

function enforceCacheLimit() {
  if (streamCache.size > MAX_CACHE_SIZE) {
    const firstKey = streamCache.keys().next().value;
    streamCache.delete(firstKey);
  }
}

function getCachedStream(url) {
  const item = streamCache.get(url);
  if (!item) return null;

  if (Date.now() > item.expire) {
    streamCache.delete(url);
    return null;
  }

  return item.audioUrl;
}

function setCachedStream(url, audioUrl) {
  streamCache.set(url, {
    audioUrl,
    expire: Date.now() + STREAM_TTL,
  });

  enforceCacheLimit();
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
    return res.status(400).json({ error: "Query obrigatória" });
  }

  const cached = searchCache.get(query);
  if (cached && Date.now() < cached.expire) {
    return res.json(cached.data);
  }

  try {
    // 🔥 PRIMEIRA TENTATIVA (normal)
    let results;

    try {
      results = await ytDlp(`ytsearch5:${query}`, {
        dumpSingleJson: true,
        noWarnings: true,
      });
    } catch (err) {
      console.log("⚠️ yt-dlp falhou, fallback ativado");

      // 🔥 FALLBACK: usa Invidious API (anti-bloqueio)
      const response = await axios.get(
        `https://yt.artemislena.eu/api/v1/search?q=${encodeURIComponent(query)}`
      );

      const tracks = response.data.slice(0, 5).map((item) => ({
        id: item.videoId,
        title: item.title,
        artist: item.author,
        duration: item.lengthSeconds,
        thumbnail: item.videoThumbnails?.[0]?.url,
        url: `https://www.youtube.com/watch?v=${item.videoId}`,
      }));

      searchCache.set(query, {
        data: tracks,
        expire: Date.now() + SEARCH_TTL,
      });

      return res.json(tracks);
    }

    // 🔥 parse normal
    const tracks = results.entries
      .filter(Boolean)
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
    console.error("Erro total:", err);
    res.status(500).json({ error: "Erro na busca" });
  }
});

// Rota de STREAMING (para o player de áudio — sem Content-Disposition: attachment)
router.get("/stream", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL não fornecida" });

    const range = req.headers.range;

    // 🔥 CACHE
    const cached = getCachedStream(url);
    let audioUrl;

    if (cached) {
      audioUrl = cached;
    } else {
      try {
        const result = await ytDlp.exec(url, {
          getUrl: true,
          noWarnings: true,
        });

        audioUrl = result.stdout.trim();
        setCachedStream(url, audioUrl);

      } catch (err) {
        console.log("⚠️ yt-dlp falhou, fallback stream");

        // 🔥 fallback: proxy alternativo
        const videoId = url.split("v=")[1];
        audioUrl = `https://inv.nadeko.net/latest_version?id=${videoId}&itag=251`;
      }
    }

    const audioStream = await axios({
      method: "GET",
      url: audioUrl,
      responseType: "stream",
      headers: range ? { Range: range } : {},
    });

    res.setHeader("Content-Type", "audio/webm");
    res.setHeader("Accept-Ranges", "bytes");

    if (audioStream.headers["content-length"]) {
      res.setHeader("Content-Length", audioStream.headers["content-length"]);
    }

    if (audioStream.headers["content-range"]) {
      res.setHeader("Content-Range", audioStream.headers["content-range"]);
      res.status(206);
    }

    audioStream.data.pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Erro no streaming",
    });
  }
});

module.exports = router;
