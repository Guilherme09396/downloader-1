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

function setCachedStream(url, audioUrl) {
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
      noCallHome: true,
    });

    const tracks = results.entries.map((item) => ({
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
    console.error(err);
    res.status(500).json({ error: err });
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

    // tenta pegar do cache
    let audioUrl = getCachedStream(url);

    if (!audioUrl) {
      const result = await ytDlp.exec(url, {
        format: "bestaudio",
        getUrl: true,
        noWarnings: true,

        extractorArgs: "youtube:player_client=android",

        addHeader: [
          "user-agent: Mozilla/5.0",
          "accept-language: en-US,en;q=0.9"
        ]
      });

      audioUrl = result.stdout.trim();
      setCachedStream(url, audioUrl);
    }

    const audioStream = await axiosInstance({
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
    res.status(500).json({ error: err });
  }
});

module.exports = router;
