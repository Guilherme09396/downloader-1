/**
 * ADICIONE ESTE CÓDIGO AO SEU BACKEND NO RAILWAY
 * 
 * Instalar: npm install cheerio
 * 
 * Adicione as rotas abaixo no seu server.js/index.js principal
 */

const axios = require("axios");
const cheerio = require("cheerio");

const SM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://suamusica.com.br/",
  Origin: "https://suamusica.com.br",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
};

/**
 * Extrai o __NEXT_DATA__ embutido no HTML das páginas do Sua Música
 */
async function fetchNextData(url) {
  const { data: html } = await axios.get(url, { headers: SM_HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const raw = $("#__NEXT_DATA__").html();
  if (!raw) throw new Error("__NEXT_DATA__ não encontrado na página");
  return JSON.parse(raw);
}

/**
 * Normaliza um objeto de música do Sua Música para o formato do SoundFlow
 */
function normalizeSong(song, cdInfo) {
  return {
    id: `sm_${song.id}`,
    title: song.name || song.title || "Sem título",
    artist: cdInfo?.artistName || cdInfo?.username || "Desconhecido",
    thumbnail:
      cdInfo?.coverUrl ||
      `https://images.suamusica.com.br/t_cd_250x250/${cdInfo?.userId}/${cdInfo?.id}/cover.jpg`,
    url: song.playUrl || song.audioUrl || song.url || null,
    duration: song.duration || 0,
    source: "suamusica",
    cdSlug: cdInfo?.slug,
    userId: cdInfo?.userId,
  };
}

// ─────────────────────────────────────────────
// ROTAS — adicione estas ao seu Express app
// ─────────────────────────────────────────────

function registerSuaMusicaRoutes(app) {
  /**
   * GET /suamusica/search?q=forrozao
   * Busca CDs/artistas no Sua Música
   */
  app.get("/suamusica/search", async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Parâmetro q obrigatório" });

    const nextData = await fetchNextData(
      `https://suamusica.com.br/busca?q=${encodeURIComponent(q)}`
    );

    // Os resultados ficam em pageProps
    const pageProps = nextData?.props?.pageProps;
    const cds = pageProps?.cds || pageProps?.albums || [];
    const profiles = pageProps?.profiles || pageProps?.users || [];

    const results = cds.map((cd) => ({
      id: `sm_cd_${cd.id}`,
      title: cd.name || cd.title,
      artist: cd.artistName || cd.username,
      thumbnail:
        cd.coverUrl ||
        `https://images.suamusica.com.br/t_cd_250x250/${cd.userId}/${cd.id}/cover.jpg`,
      cdUrl: `https://suamusica.com.br/${cd.username || cd.slug}/${cd.slug || cd.id}`,
      source: "suamusica",
      type: "cd",
    }));

    res.json({ results, profiles });
  });

  /**
   * GET /suamusica/cd?url=https://suamusica.com.br/artista/cd-slug
   * Retorna as músicas de um CD
   */
  app.get("/suamusica/cd", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Parâmetro url obrigatório" });

    const nextData = await fetchNextData(url);
    const pageProps = nextData?.props?.pageProps;

    // As músicas podem estar em vários campos dependendo do tipo de página
    const songs =
      pageProps?.songs ||
      pageProps?.musics ||
      pageProps?.cd?.songs ||
      pageProps?.album?.songs ||
      [];

    const cdInfo = pageProps?.cd || pageProps?.album || pageProps || {};

    const tracks = songs.map((song) => normalizeSong(song, cdInfo));

    res.json({
      cd: {
        title: cdInfo.name || cdInfo.title,
        artist: cdInfo.artistName || cdInfo.username,
        thumbnail:
          cdInfo.coverUrl ||
          `https://images.suamusica.com.br/t_cd_250x250/${cdInfo.userId}/${cdInfo.id}/cover.jpg`,
      },
      tracks,
    });
  });

  /**
   * GET /suamusica/stream?url=<audio_url>
   * Proxy do stream de áudio do Sua Música (evita CORS)
   */
  app.get("/suamusica/stream", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Parâmetro url obrigatório" });

    const response = await axios.get(url, {
      headers: {
        ...SM_HEADERS,
        Range: req.headers.range || "bytes=0-",
      },
      responseType: "stream",
      timeout: 30000,
    });

    res.status(response.status);
    res.set({
      "Content-Type": response.headers["content-type"] || "audio/mpeg",
      "Content-Length": response.headers["content-length"],
      "Accept-Ranges": "bytes",
      "Content-Range": response.headers["content-range"],
    });

    response.data.pipe(res);
  });

  /**
   * GET /suamusica/profile?username=forrozaodevilla
   * Retorna os CDs de um artista
   */
  app.get("/suamusica/profile", async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Parâmetro username obrigatório" });

    const nextData = await fetchNextData(
      `https://suamusica.com.br/${username}`
    );
    const pageProps = nextData?.props?.pageProps;
    const cds = pageProps?.cds || pageProps?.albums || [];

    const result = cds.map((cd) => ({
      id: `sm_cd_${cd.id}`,
      title: cd.name || cd.title,
      thumbnail:
        cd.coverUrl ||
        `https://images.suamusica.com.br/t_cd_250x250/${cd.userId}/${cd.id}/cover.jpg`,
      cdUrl: `https://suamusica.com.br/${username}/${cd.slug || cd.id}`,
      source: "suamusica",
    }));

    res.json({
      profile: {
        username,
        name: pageProps?.user?.name || pageProps?.profile?.name,
        avatar: pageProps?.user?.avatarUrl,
      },
      cds: result,
    });
  });
};

module.exports = registerSuaMusicaRoutes;