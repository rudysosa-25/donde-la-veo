// ¿Dónde la veo? - API Worker
// Endpoint: GET /api/search?q=<titulo>&country=<ISO 3166-1 alpha-2>

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_LANGUAGE = "es-ES";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

// Best-effort title cleanup: removes filler words, accents, and noise
// before hitting the search API. Improves match rate for casual input
// like "la pelicula de matrix".
export function normalizeTitle(raw) {
  let t = raw.trim();
  t = t.replace(
    /\b(pelicula|pel[íi]cula|serie|documental|d[eo]l|la|el|los|las|un[ao]?)\b/gi,
    " ",
  );
  t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  t = t.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return t || raw.trim();
}

async function tmdbFetch(path, params, apiKey) {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("language", TMDB_LANGUAGE);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, v);
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`TMDb ${path} failed (${resp.status})`);
  }
  return resp.json();
}

async function searchProviders(env, query, country) {
  const apiKey = env.TMDB_API_KEY;
  const normalized = normalizeTitle(query);

  const search = await tmdbFetch(
    "/search/multi",
    { query: normalized, include_adult: "false" },
    apiKey,
  );

  const result = (search.results || []).find(
    (r) => r.media_type === "movie" || r.media_type === "tv",
  );
  if (!result) {
    return { found: false, source: "tmdb", normalized };
  }

  const type = result.media_type;
  const id = result.id;
  const providers = await tmdbFetch(`/${type}/${id}/watch/providers`, {}, apiKey);

  const region = (providers.results || {})[country.toUpperCase()] || null;

  return {
    found: true,
    source: "tmdb",
    normalized,
    title: {
      id,
      type,
      name: result.title || result.name || query,
      year: (result.release_date || result.first_air_date || "").slice(0, 4),
      overview: result.overview || "",
      poster: result.poster_path
        ? `https://image.tmdb.org/t/p/w300${result.poster_path}`
        : null,
    },
    providers: region
      ? {
          flatrate: (region.flatrate || []).map((p) => p.provider_name),
          rent: (region.rent || []).map((p) => p.provider_name),
          buy: (region.buy || []).map((p) => p.provider_name),
          link: region.link || null,
        }
      : null,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true });
    }

    if (url.pathname !== "/api/search" || request.method !== "GET") {
      return errorResponse("Not found", 404);
    }

    const query = url.searchParams.get("q") || "";
    const country = url.searchParams.get("country") || "AR";

    if (!query.trim()) {
      return errorResponse("Missing required parameter: q");
    }
    if (!/^[A-Za-z]{2}$/.test(country)) {
      return errorResponse("Invalid country code (expected 2 letters)");
    }
    if (!env.TMDB_API_KEY) {
      return errorResponse("TMDB_API_KEY is not configured", 500);
    }

    try {
      const result = await searchProviders(env, query, country);
      return json(result);
    } catch (err) {
      console.error("search error:", err);
      return errorResponse("Failed to fetch data", 502);
    }
  },
};
