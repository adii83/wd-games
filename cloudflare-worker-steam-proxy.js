/**
 * Steam Store API CORS proxy — Cloudflare Worker.
 *
 * Why this exists: admin.html's "Cari dari Steam" auto-fill feature needs to
 * call Steam's storesearch/appdetails endpoints from the browser, but Steam's
 * API does not send Access-Control-Allow-Origin headers, so the browser
 * blocks the request outright (confirmed directly — a plain fetch() to
 * store.steampowered.com from a page origin fails with "TypeError: Failed to
 * fetch" before Steam ever sees it reach app code). This Worker sits between
 * admin.html and Steam, adding the CORS headers Steam doesn't provide.
 * It is a stateless pass-through — no data is stored, logged, or modified.
 *
 * Deploy (free tier, no credit card required):
 *   1. https://dash.cloudflare.com -> sign up / log in.
 *   2. Workers & Pages -> Create -> "Create Worker".
 *   3. Give it any name (e.g. "wd-games-steam-proxy") -> Deploy.
 *   4. Click "Edit code", replace the default contents with this whole file,
 *      then "Deploy" again.
 *   5. Copy the *.workers.dev URL Cloudflare gives you and paste it into
 *      STEAM_PROXY_BASE_URL near the top of js/admin.js.
 *
 * Re-deploy any time this file changes (paste the updated contents into the
 * same Worker's editor and hit Deploy again — there's no CI/build step here,
 * matching the rest of this project).
 */

// Wide open on purpose: this proxy only ever relays PUBLIC Steam search
// results (no auth, no write access, no admin data touches it), so there's
// nothing to protect by restricting the origin — and restricting it caused
// real friction (e.g. opening admin.html directly as a file:// page, which
// sends Origin: null and doesn't match any real https:// origin anyway).
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

async function proxyJson(targetUrl) {
  const upstream = await fetch(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (WD Games admin panel Steam lookup)' },
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/storesearch') {
      const term = url.searchParams.get('term') || '';
      if (!term.trim()) {
        return new Response(JSON.stringify({ error: 'Missing term' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
      const target = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=us`;
      return proxyJson(target);
    }

    if (url.pathname === '/appdetails') {
      const appid = url.searchParams.get('appid') || '';
      if (!/^\d+$/.test(appid)) {
        return new Response(JSON.stringify({ error: 'Missing/invalid appid' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
      const target = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`;
      return proxyJson(target);
    }

    return new Response('Not found. Use /storesearch?term=... or /appdetails?appid=...', {
      status: 404,
      headers: corsHeaders(),
    });
  },
};
