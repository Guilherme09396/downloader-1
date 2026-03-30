const express = require("express");
const ytDlp = require("yt-dlp-exec");
const axios = require("axios");
const http = require("http");
const https = require("https");
const path = require("path");

const router = express.Router();

// =======================
// COOKIES PATH
// =======================
const COOKIES_PATH = path.join(__dirname, "../../cookies.txt");

// =======================
// AXIOS CONFIG
// =======================
const axiosInstance = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
  timeout: 15000,
});

// =======================
// CACHE STREAM (1h)
// =======================
const streamCache = new Map();
const STREAM_TTL = 1000 * 60 * 60;

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
  streamCache.set(url, { audioUrl, expire: Date.now() + STREAM_TTL });
}

// =======================
// CACHE SEARCH (30min)
// =======================
const searchCache = new Map();
const SEARCH_TTL = 1000 * 60 * 30;

// =======================
// CONFIG YT-DLP
// =======================
const BASE_HEADERS = [
  "user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "accept-language: en-US,en;q=0.9",
];

// Formatos de áudio em ordem de preferência (IDs diretos — evita problema do DASH)
// 251=opus 141k, 140=m4a 129k, 249=opus 55k, 139=m4a 49k, 18=mp4 360p (tem áudio)
const AUDIO_FORMAT_PREFERENCE = "251/140/249/139/18";

const YT_DLP_STRATEGIES = [
  {
    noWarnings: true,
    noCheckCertificate: true,
    cookies: COOKIES_PATH,
    extractorArgs: "youtube:player_client=web",
    addHeader: BASE_HEADERS,
  },
  {
    noWarnings: true,
    noCheckCertificate: true,
    cookies: COOKIES_PATH,
    extractorArgs: "youtube:player_client=tv_embedded",
    addHeader: BASE_HEADERS,
  },
  {
    noWarnings: true,
    noCheckCertificate: true,
    cookies: COOKIES_PATH,
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
// PRE-FETCH CACHE
// =======================
async function preFetchAudioUrl(youtubeUrl) {
  if (getCachedStream(youtubeUrl)) return;
  try {
    const result = await runYtDlpWithFallback((opts) =>
      ytDlp(youtubeUrl, {
        ...opts,
        format: AUDIO_FORMAT_PREFERENCE,
        getUrl: true,
      })
    );
    // getUrl pode retornar múltiplas linhas em DASH — pega só a primeira (áudio)
    const audioUrl = result.trim().split("\n")[0];
    if (audioUrl) setCachedStream(youtubeUrl, audioUrl);
  } catch (_) { }
}

// =======================
// TEST
// =======================
router.get("/", (req, res) => {
  return res.send("API funcionando 🚀");
});

// =======================
// DEBUG (remova após confirmar que está funcionando)
// =======================
router.get("/debug", async (req, res) => {
  const fs = require("fs");
  const { execSync, execFileSync } = require("child_process");
  const results = {};

  try {
    results.ytdlpVersion = execSync(
      "/app/node_modules/yt-dlp-exec/bin/yt-dlp --version"
    ).toString().trim();
  } catch (e) {
    results.ytdlpVersion = "erro: " + e.message;
  }

  try {
    const stat = fs.statSync(COOKIES_PATH);
    results.cookiesExists = true;
    results.cookiesSize = stat.size + " bytes";
    results.cookiesModified = stat.mtime;
    const lines = fs.readFileSync(COOKIES_PATH, "utf8").split("\n").slice(0, 3);
    results.cookiesFirstLines = lines;
  } catch (e) {
    results.cookiesExists = false;
    results.cookiesError = e.message;
  }

  try {
    const output = execFileSync(
      "/app/node_modules/yt-dlp-exec/bin/yt-dlp",
      [
        "https://www.youtube.com/watch?v=jK2k1P56Cno",
        "--list-formats",
        "--no-check-certificate",
        "--cookies", COOKIES_PATH,
      ],
      { encoding: "utf8", timeout: 30000 }
    );
    results.formats = output;
  } catch (e) {
    results.formatsError = e.stderr || e.message;
  }

  res.json(results);
});

// =======================
// DOWNLOAD
// =======================
router.get("/download", async (req, res) => {
  const fs = require("fs");
  const os = require("os");
  const crypto = require("crypto");

  try {
    const { url, title } = req.query;
    if (!url) return res.status(400).json({ error: "URL não fornecida" });

    const filename = title ? `${title}.mp3` : "music.mp3";
    const tmpId = crypto.randomBytes(8).toString("hex");
    const tmpDir = path.join(os.tmpdir(), `music-dl-${tmpId}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    await runYtDlpWithFallback((opts) =>
      ytDlp(url, {
        ...opts,
        format: AUDIO_FORMAT_PREFERENCE,
        extractAudio: true,
        audioFormat: "mp3",
        audioQuality: 0,
        addMetadata: true,
        embedThumbnail: true,
        convertThumbnails: "jpg",
        postprocessorArgs: "ffmpeg:-id3v2_version 3",
        output: path.join(tmpDir, "audio.%(ext)s"),
      })
    );

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
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);

    const readStream = fs.createReadStream(mp3Path);
    readStream.pipe(res);
    readStream.on("end", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { } });
    readStream.on("error", (err) => {
      console.error("Read stream error:", err);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
      if (!res.headersSent) res.status(500).json({ error: "Erro ao ler arquivo" });
    });
  } catch (error) {
    console.error("Download error:", error);
    if (!res.headersSent)
      res.status(500).json({ error: "Erro no download", details: error.stderr || error.message });
  }
});

// =======================
// INFO
// =======================
router.post("/info", async (req, res) => {
  const { url } = req.body;
  try {
    const info = await runYtDlpWithFallback((opts) =>
      ytDlp(url, { ...opts, dumpSingleJson: true })
    );
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
    res.status(500).json({ error: "Erro ao buscar vídeo", details: err.stderr || err.message });
  }
});

// =======================
// SEARCH
// =======================
router.post("/search", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "É necessário informar o query" });

  const cached = searchCache.get(query);
  if (cached && Date.now() < cached.expire) return res.json(cached.data);

  try {
    const results = await runYtDlpWithFallback((opts) =>
      ytDlp(`ytsearch5:${query}`, { ...opts, dumpSingleJson: true })
    );

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

    searchCache.set(query, { data: tracks, expire: Date.now() + SEARCH_TTL });
    tracks.slice(0, 3).forEach((t) => preFetchAudioUrl(t.url));
    res.json(tracks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro na busca", details: err.stderr || err.message });
  }
});

// =======================
// STREAM
// =======================
router.get("/stream", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL não fornecida" });

    const range = req.headers.range;
    let audioUrl = getCachedStream(url);

    if (!audioUrl) {
      const result = await runYtDlpWithFallback((opts) =>
        ytDlp(url, {
          ...opts,
          format: AUDIO_FORMAT_PREFERENCE,
          getUrl: true,
        })
      );
      // pega só a primeira linha (evita problema de DASH retornar 2 URLs)
      audioUrl = result.trim().split("\n")[0];
      if (!audioUrl) return res.status(500).json({ error: "Não foi possível obter URL de áudio" });
      setCachedStream(url, audioUrl);
    }

    const audioStream = await axiosInstance({
      method: "GET",
      url: audioUrl,
      responseType: "stream",
      headers: range ? { Range: range } : {},
    });

    res.status(audioStream.status === 206 ? 206 : 200);
    res.setHeader("Content-Type", audioStream.headers["content-type"] || "audio/webm");
    res.setHeader("Accept-Ranges", "bytes");
    if (audioStream.headers["content-length"])
      res.setHeader("Content-Length", audioStream.headers["content-length"]);
    if (audioStream.headers["content-range"])
      res.setHeader("Content-Range", audioStream.headers["content-range"]);

    audioStream.data.pipe(res);
    audioStream.data.on("error", (err) => {
      console.error("Stream pipe error:", err);
      streamCache.delete(url);
    });
  } catch (err) {
    console.error(err);
    streamCache.delete(req.query.url);
    if (!res.headersSent)
      res.status(500).json({ error: "Erro ao streamar áudio", details: err.stderr || err.message });
  }
});

module.exports = router;