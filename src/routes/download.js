const express = require("express");
const ytDlp = require("yt-dlp-exec");
const axios = require("axios");
const http = require("http");
const https = require("https");

const router = express.Router();

// =======================
// AXIOS CONFIG
// =======================
const axiosInstance = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
  timeout: 15000, // reduzido de 30s para 15s
});

// =======================
// CACHE STREAM (aumentado para 1h)
// =======================
const streamCache = new Map();
const STREAM_TTL = 1000 * 60 * 60; // 1 hora

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

// =======================
// CACHE SEARCH (aumentado para 30min)
// =======================
const searchCache = new Map();
const SEARCH_TTL = 1000 * 60 * 30; // 30 minutos

// =======================
// PRE-FETCH CACHE 🔥
// Busca a URL de áudio em background assim que a música aparece na busca
// =======================
async function preFetchAudioUrl(youtubeUrl) {
  if (getCachedStream(youtubeUrl)) return; // já está em cache
  try {
    const result = await runYtDlpWithFallback((opts) =>
      ytDlp(youtubeUrl, {
        ...opts,
        format: "bestaudio[ext=webm]/bestaudio/best",
        getUrl: true,
      })
    );
    const audioUrl = result.trim();
    if (audioUrl) setCachedStream(youtubeUrl, audioUrl);
  } catch (_) {
    // silencioso — é apenas um pre-fetch
  }
}

// =======================
// CONFIG YT-DLP
// =======================
const BASE_HEADERS = [
  "user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "accept-language: en-US,en;q=0.9",
];

const YT_DLP_STRATEGIES = [
  {
    noWarnings: true,
    noCheckCertificate: true,
    extractorArgs: "youtube:player_client=web",
    addHeader: BASE_HEADERS,
  },
  {
    noWarnings: true,
    noCheckCertificate: true,
    extractorArgs: "youtube:player_client=tv_embedded",
    addHeader: BASE_HEADERS,
  },
  {
    noWarnings: true,
    noCheckCertificate: true,
    addHeader: BASE_HEADERS,
  },
];

async function runYtDlpWithFallback(fn) {
  let lastError;
  for (const opts of YT_DLP_STRATEGIES) {
    try {
      return await fn(opts);
    } catch (err) {
      lastError = err;
      console.warn("⚠️ Estratégia falhou, tentando próxima...");
    }
  }
  throw lastError;
}

// =======================
// TEST
// =======================
router.get("/", (req, res) => {
  return res.send("API funcionando 🚀");
});

// =======================
// DOWNLOAD (with metadata + cover)
// =======================
router.get("/download", async (req, res) => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const crypto = require("crypto");

  try {
    const { url, title } = req.query;

    if (!url) {
      return res.status(400).json({ error: "URL não fornecida" });
    }

    const filename = title ? `${title}.mp3` : "music.mp3";
    const tmpId = crypto.randomBytes(8).toString("hex");
    const tmpDir = path.join(os.tmpdir(), `music-dl-${tmpId}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const outputTemplate = path.join(tmpDir, "audio.%(ext)s");

    await ytDlp(url, {
      noWarnings: true,
      noCheckCertificate: true,
      addHeader: BASE_HEADERS,
      format: "bestaudio/best",
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: 0,
      addMetadata: true,
      embedThumbnail: true,
      convertThumbnails: "jpg",
      postprocessorArgs: "ffmpeg:-id3v2_version 3",
      output: outputTemplate,
    });

    const files = fs.readdirSync(tmpDir);
    const mp3File = files.find((f) => f.endsWith(".mp3"));

    if (!mp3File) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
      return res.status(500).json({ error: "Arquivo MP3 não encontrado após conversão" });
    }

    const mp3Path = path.join(tmpDir, mp3File);
    const stat = fs.statSync(mp3Path);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    const readStream = fs.createReadStream(mp3Path);
    readStream.pipe(res);

    readStream.on("end", () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    });

    readStream.on("error", (err) => {
      console.error("Read stream error:", err);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
      if (!res.headersSent) {
        res.status(500).json({ error: "Erro ao ler arquivo" });
      }
    });
  } catch (error) {
    console.error("Download error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro no download", details: error.stderr || error.message });
    }
  }
});

// =======================
// INFO
// =======================
router.post("/info", async (req, res) => {
  const { url } = req.body;

  try {
    const info = await runYtDlpWithFallback((opts) =>
      ytDlp(url, {
        ...opts,
        dumpSingleJson: true,
      })
    );

    // Pre-fetch em background para acelerar o stream futuro
    preFetchAudioUrl(url);

    res.json({
      id: info.id,
      title: info.title,
      artist: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail,
      url: info.webpage_url,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Erro ao buscar vídeo",
      details: err.stderr || err.message,
    });
  }
});

// =======================
// SEARCH
// =======================
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
    const results = await runYtDlpWithFallback((opts) =>
      ytDlp(`ytsearch5:${query}`, {
        ...opts,
        dumpSingleJson: true,
      })
    );

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

    // 🔥 Pre-fetch a URL de áudio das primeiras 3 músicas em background
    tracks.slice(0, 3).forEach((t) => preFetchAudioUrl(t.url));

    res.json(tracks);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Erro na busca",
      details: err.stderr || err.message,
    });
  }
});

// =======================
// STREAM
// =======================
router.get("/stream", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: "URL não fornecida" });
    }

    const range = req.headers.range;

    let audioUrl = getCachedStream(url);

    if (!audioUrl) {
      const result = await runYtDlpWithFallback((opts) =>
        ytDlp(url, {
          ...opts,
          format: "bestaudio[ext=webm]/bestaudio/best",
          getUrl: true,
        })
      );

      audioUrl = result.trim();

      if (!audioUrl) {
        return res.status(500).json({ error: "Não foi possível obter URL de áudio" });
      }

      setCachedStream(url, audioUrl);
    }

    const audioStream = await axiosInstance({
      method: "GET",
      url: audioUrl,
      responseType: "stream",
      headers: range ? { Range: range } : {},
    });

    const status = audioStream.status === 206 ? 206 : 200;
    res.status(status);

    res.setHeader("Content-Type", audioStream.headers["content-type"] || "audio/webm");
    res.setHeader("Accept-Ranges", "bytes");

    if (audioStream.headers["content-length"]) {
      res.setHeader("Content-Length", audioStream.headers["content-length"]);
    }
    if (audioStream.headers["content-range"]) {
      res.setHeader("Content-Range", audioStream.headers["content-range"]);
    }

    audioStream.data.pipe(res);

    audioStream.data.on("error", (err) => {
      console.error("Stream pipe error:", err);
      streamCache.delete(url);
    });
  } catch (err) {
    console.error(err);
    streamCache.delete(req.query.url);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Erro ao streamar áudio",
        details: err.stderr || err.message,
      });
    }
  }
});

module.exports = router;