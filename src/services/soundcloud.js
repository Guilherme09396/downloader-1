const axios = require("axios");

let CLIENT_ID = null;

// =======================
// GET CLIENT ID
// =======================
async function getClientId() {
  if (CLIENT_ID) return CLIENT_ID;

  const { data: html } = await axios.get("https://soundcloud.com");

  const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/.*?\.js)"/g)]
    .map(m => m[1]);

  for (const url of scripts) {
    try {
      const { data: js } = await axios.get(url);
      const match = js.match(/client_id:"([a-zA-Z0-9]+)"/);

      if (match) {
        CLIENT_ID = match[1];
        console.log("🔥 SoundCloud client_id carregado");
        return CLIENT_ID;
      }
    } catch (_) { }
  }

  throw new Error("Erro ao obter client_id");
}

// =======================
// SEARCH TRACKS
// =======================
async function searchTracks(query) {
  const client_id = await getClientId();

  const { data } = await axios.get(
    "https://api-v2.soundcloud.com/search/tracks",
    {
      params: {
        q: query,
        client_id,
        limit: 10,
      },
    }
  );

  return data.collection.map(track => ({
    id: track.id,
    title: track.title,
    artist: track.user?.username || "Unknown",
    duration: Math.floor(track.duration / 1000),
    thumbnail: track.artwork_url,
    url: track.permalink_url,
    _raw: track,
  }));
}

// =======================
// GET STREAM URL
// =======================
async function getStreamUrl(track) {
  const client_id = await getClientId();

  const transcoding = track.media?.transcodings?.find(
    t => t.format.protocol === "progressive"
  );

  if (!transcoding) {
    throw new Error("Sem stream disponível");
  }

  const { data } = await axios.get(transcoding.url, {
    params: { client_id },
  });

  return data.url;
}

module.exports = {
  searchTracks,
  getStreamUrl,
};