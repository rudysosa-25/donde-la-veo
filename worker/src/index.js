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
    /\b(pelicula|pel[íi]cula|serie|documental|d[eo]l?|la|el|los|las|un[ao]?)\b/gi,
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

// JustWatch's undocumented GraphQL API. Used to enrich TMDb results with
// per-provider deep links and as a fallback when TMDb has no offers for a
// region. May break without notice; failures must be non-fatal.
const JW_GRAPHQL = "https://apis.justwatch.com/graphql";
const JW_HEADERS = {
  "Content-Type": "application/json",
  // JustWatch blocks requests without a browser-like User-Agent.
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

const JW_SEARCH_QUERY = `query($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, filter: $filter) {
    edges {
      node {
        objectType
        content(country: $country, language: $language) { title originalReleaseYear fullPath }
        offers(country: $country, platform: WEB) {
          monetizationType
          standardWebURL
          package { packageId }
        }
      }
    }
  }
}`;

// Returns the first JustWatch title matching `query`, with offers grouped
// by packageId: { "339": { monetizationType, url } }. Returns null on any
// failure (unofficial API — never fatal).
async function justWatchSearch(query, country, language = "es") {
  try {
    const resp = await fetch(JW_GRAPHQL, {
      method: "POST",
      headers: JW_HEADERS,
      body: JSON.stringify({
        query: JW_SEARCH_QUERY,
        variables: {
          country: country.toUpperCase(),
          language,
          first: 4,
          filter: { searchQuery: query, objectTypes: ["MOVIE", "SHOW"] },
        },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const edges = data?.data?.popularTitles?.edges || [];
    if (edges.length === 0) return null;

    const offersByPackage = {};
    for (const edge of edges) {
      for (const offer of edge.node.offers || []) {
        const pkgId = offer?.package?.packageId;
        if (!pkgId) continue;
        // Keep the first offer per packageId + monetization combination.
        const key = `${pkgId}:${offer.monetizationType}`;
        if (!offersByPackage[key]) {
          offersByPackage[key] = {
            monetizationType: offer.monetizationType,
            url: offer.standardWebURL || null,
          };
        }
      }
    }
    return Object.keys(offersByPackage).length > 0 ? { offersByPackage } : null;
  } catch {
    return null; // Non-fatal by design
  }
}

// TMDb catalog of providers for a region: { "8": "Netflix", ... }.
// Needed to translate JustWatch packageIds into provider names.
async function providerNameMap(type, country, apiKey) {
  try {
    const data = await tmdbFetch(
      `/watch/providers/${type === "tv" ? "tv" : "movie"}`,
      { watch_region: country.toUpperCase() },
      apiKey,
    );
    const map = {};
    for (const p of data.results || []) {
      map[p.provider_id] = p.provider_name;
    }
    return map;
  } catch {
    return {};
  }
}

// Returns the JustWatch offer whose key ends with ":<monetization>" for the
// given packageId, e.g. "339:FLATRATE".
function jwOfferFor(jwOffers, providerId, monetizations) {
  if (!jwOffers || !providerId) return null;
  for (const m of monetizations) {
    const offer = jwOffers[`${providerId}:${m}`];
    if (offer) return offer;
  }
  return null;
}

// Merge TMDb region data and JustWatch offers into one grouped structure.
// Each entry: { name, url } where url is the JustWatch deep link when known.
function mergeProviders(tmdbRegion, jwOffers, nameMap) {
  const groups = {
    flatrate: { tmdb: tmdbRegion?.flatrate || [], jw: ["FLATRATE"] },
    rent: { tmdb: tmdbRegion?.rent || [], jw: ["RENT"] },
    buy: { tmdb: tmdbRegion?.buy || [], jw: ["BUY"] },
  };

  const result = {};
  let total = 0;
  for (const [group, { tmdb, jw: monetizations }] of Object.entries(groups)) {
    const seen = new Set();
    const entries = [];
    for (const p of tmdb) {
      if (seen.has(p.provider_name)) continue;
      seen.add(p.provider_name);
      const offer = jwOfferFor(jwOffers, p.provider_id, monetizations);
      entries.push({ name: p.provider_name, url: offer ? offer.url : null });
    }
    // Fallback: add JustWatch-only providers that TMDb did not list.
    for (const [key, offer] of Object.entries(jwOffers || {})) {
      if (!monetizations.some((m) => key.endsWith(":" + m))) continue;
      const pkgId = key.split(":")[0];
      if (tmdb.some((p) => String(p.provider_id) === pkgId)) continue;
      const name = nameMap[pkgId] || `Proveedor ${pkgId}`;
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({ name, url: offer.url });
    }
    result[group] = entries;
    total += entries.length;
  }

  result.link = tmdbRegion?.link || null;
  result.total = total;
  return result;
}

async function tmdbSearchMulti(query, apiKey) {
  return tmdbFetch(
    "/search/multi",
    { query, include_adult: "false" },
    apiKey,
  );
}

function pickResult(search) {
  return (search.results || []).find(
    (r) => r.media_type === "movie" || r.media_type === "tv",
  );
}

async function searchProviders(env, query, country) {
  const apiKey = env.TMDB_API_KEY;
  const normalized = normalizeTitle(query);

  // Two-stage search: try the raw query first (TMDb handles it well),
  // fall back to the cleaned-up title only if the raw query misses.
  let search = await tmdbSearchMulti(query, apiKey);
  let result = pickResult(search);
  let usedQuery = query;
  if (!result) {
    search = await tmdbSearchMulti(normalized, apiKey);
    result = pickResult(search);
    usedQuery = normalized;
  }
  if (!result) {
    return { found: false, source: "tmdb", normalized };
  }

  const type = result.media_type;
  const id = result.id;

  // Fetch TMDb providers, the provider name map, and JustWatch offers in
  // parallel. JustWatch and the name map are best-effort enrichments.
  const [providers, nameMap, jw] = await Promise.all([
    tmdbFetch(`/${type}/${id}/watch/providers`, {}, apiKey),
    providerNameMap(type, country, apiKey),
    justWatchSearch(result.title || result.name || usedQuery, country),
  ]);

  const region = (providers.results || {})[country.toUpperCase()] || null;
  const merged = mergeProviders(region, jw?.offersByPackage || null, nameMap);

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
    providers: merged.total > 0
      ? {
          flatrate: merged.flatrate,
          rent: merged.rent,
          buy: merged.buy,
          link: merged.link,
          sources: region ? ["tmdb", ...(jw ? ["justwatch"] : [])] : (jw ? ["justwatch"] : []),
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
