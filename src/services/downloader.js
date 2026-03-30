const ytDlp = require("yt-dlp-exec");
const path = require("path");

const COOKIES_PATH = path.join(__dirname, "../../cookies.txt");

const BASE_HEADERS = [
  "user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "accept-language: en-US,en;q=0.9",
];

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

async function downloadMusic(url) {
  const output = path.join(__dirname, "../downloads/%(title)s.%(ext)s");

  await runYtDlpWithFallback((opts) =>
    ytDlp(url, {
      ...opts,
      format: "bestaudio/best",
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: 0,
      addMetadata: true,
      writeThumbnail: true,
      embedThumbnail: true,
      output,
    })
  );

  return "Download finalizado";
}

module.exports = downloadMusic;