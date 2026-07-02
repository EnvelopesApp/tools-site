const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const EVENT_NAMES = new Set([
  "page_view",
  "ad_landing",
  "download_click",
  "checkout_click",
  "demo_play",
  "support_email_click",
  "external_click"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return Response.redirect(`${url.origin}/admin`, 302);
    }

    if (url.pathname === "/track" && request.method === "POST") {
      return trackEvent(request, env);
    }

    if (url.pathname === "/api/summary" && request.method === "GET") {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const days = clampNumber(url.searchParams.get("days"), 1, 365, 30);
      return json(await getSummary(env, days));
    }

    if (url.pathname === "/admin" && request.method === "GET") {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const days = clampNumber(url.searchParams.get("days"), 1, 365, 30);
      const summary = await getSummary(env, days);
      return html(renderDashboard(summary, days));
    }

    return new Response("Not found", { status: 404 });
  }
};

async function trackEvent(request, env) {
  const corsDenied = validateOrigin(request, env);
  if (corsDenied) return corsDenied;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return withCors(json({ ok: false, error: "invalid_json" }, 400), request, env);
  }

  const eventName = cleanText(payload.event, 64);
  if (!EVENT_NAMES.has(eventName)) {
    return withCors(json({ ok: false, error: "invalid_event" }, 400), request, env);
  }

  const pageUrl = cleanUrl(payload.pageUrl);
  const referrer = cleanUrl(payload.referrer);
  const targetUrl = cleanUrl(payload.targetUrl);
  const cf = request.cf || {};

  await env.DB.prepare(`
    INSERT INTO events (
      event_name, app, page_url, page_path, referrer, referrer_host,
      source, medium, campaign, term, content, has_gclid,
      target_url, target_label, target_kind, platform, session_id,
      device, language, country, colo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    eventName,
    cleanText(payload.app, 40),
    pageUrl,
    cleanText(payload.pagePath || pathFromUrl(pageUrl), 160),
    referrer,
    cleanText(payload.referrerHost || hostFromUrl(referrer), 120),
    cleanText(payload.source, 80),
    cleanText(payload.medium, 80),
    cleanText(payload.campaign, 120),
    cleanText(payload.term, 120),
    cleanText(payload.content, 120),
    payload.hasGclid ? 1 : 0,
    targetUrl,
    cleanText(payload.targetLabel, 160),
    cleanText(payload.targetKind, 60),
    cleanText(payload.platform, 80),
    cleanText(payload.sessionId, 80),
    cleanText(payload.device, 40),
    cleanText(payload.language, 40),
    cleanText(cf.country, 8),
    cleanText(cf.colo, 16)
  ).run();

  return withCors(json({ ok: true }), request, env);
}

async function getSummary(env, days) {
  const params = [`-${days} days`];

  const totals = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total_events,
      COUNT(DISTINCT session_id) AS sessions,
      SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS page_views,
      SUM(CASE WHEN event_name = 'ad_landing' THEN 1 ELSE 0 END) AS ad_landings,
      SUM(CASE WHEN event_name = 'download_click' THEN 1 ELSE 0 END) AS downloads,
      SUM(CASE WHEN event_name = 'checkout_click' THEN 1 ELSE 0 END) AS checkout_clicks,
      SUM(CASE WHEN event_name = 'demo_play' THEN 1 ELSE 0 END) AS demo_plays
    FROM events
    WHERE created_at >= datetime('now', ?)
  `).bind(...params).first();

  const funnel = await env.DB.prepare(`
    WITH session_flags AS (
      SELECT
        session_id,
        MAX(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS viewed,
        MAX(CASE WHEN event_name = 'ad_landing' THEN 1 ELSE 0 END) AS ad_landed,
        MAX(CASE WHEN event_name = 'demo_play' THEN 1 ELSE 0 END) AS played_demo,
        MAX(CASE WHEN event_name = 'download_click' THEN 1 ELSE 0 END) AS downloaded,
        MAX(CASE WHEN event_name = 'checkout_click' THEN 1 ELSE 0 END) AS checked_out
      FROM events
      WHERE created_at >= datetime('now', ?) AND session_id IS NOT NULL
      GROUP BY session_id
    )
    SELECT
      SUM(viewed) AS viewed,
      SUM(ad_landed) AS ad_landed,
      SUM(played_demo) AS played_demo,
      SUM(downloaded) AS downloaded,
      SUM(checked_out) AS checked_out
    FROM session_flags
  `).bind(...params).first();

  const byDay = await env.DB.prepare(`
    SELECT substr(created_at, 1, 10) AS day, event_name, COUNT(*) AS count
    FROM events
    WHERE created_at >= datetime('now', ?)
    GROUP BY day, event_name
    ORDER BY day DESC, event_name
  `).bind(...params).all();

  const bySource = await env.DB.prepare(`
    SELECT
      COALESCE(NULLIF(source, ''), CASE WHEN has_gclid = 1 THEN 'google_ads' END, NULLIF(referrer_host, ''), 'direct') AS source,
      COALESCE(NULLIF(medium, ''), CASE WHEN has_gclid = 1 THEN 'cpc' END, '') AS medium,
      COUNT(*) AS events,
      COUNT(DISTINCT session_id) AS sessions,
      SUM(CASE WHEN event_name = 'download_click' THEN 1 ELSE 0 END) AS downloads,
      SUM(CASE WHEN event_name = 'checkout_click' THEN 1 ELSE 0 END) AS checkout_clicks
    FROM events
    WHERE created_at >= datetime('now', ?)
    GROUP BY source, medium
    ORDER BY sessions DESC, events DESC
    LIMIT 20
  `).bind(...params).all();

  const byCampaign = await env.DB.prepare(`
    SELECT
      COALESCE(NULLIF(campaign, ''), '(none)') AS campaign,
      COALESCE(NULLIF(source, ''), CASE WHEN has_gclid = 1 THEN 'google_ads' END, 'direct') AS source,
      COUNT(DISTINCT session_id) AS sessions,
      SUM(CASE WHEN event_name = 'download_click' THEN 1 ELSE 0 END) AS downloads,
      SUM(CASE WHEN event_name = 'checkout_click' THEN 1 ELSE 0 END) AS checkout_clicks
    FROM events
    WHERE created_at >= datetime('now', ?)
    GROUP BY campaign, source
    ORDER BY sessions DESC, downloads DESC
    LIMIT 20
  `).bind(...params).all();

  const downloads = await env.DB.prepare(`
    SELECT
      COALESCE(NULLIF(app, ''), 'unknown') AS app,
      COALESCE(NULLIF(platform, ''), 'unknown') AS platform,
      COUNT(*) AS count
    FROM events
    WHERE created_at >= datetime('now', ?) AND event_name = 'download_click'
    GROUP BY app, platform
    ORDER BY count DESC
  `).bind(...params).all();

  const checkouts = await env.DB.prepare(`
    SELECT COALESCE(NULLIF(app, ''), 'unknown') AS app, COUNT(*) AS count
    FROM events
    WHERE created_at >= datetime('now', ?) AND event_name = 'checkout_click'
    GROUP BY app
    ORDER BY count DESC
  `).bind(...params).all();

  const latest = await env.DB.prepare(`
    SELECT created_at, event_name, app, page_path, source, medium, campaign, target_label, platform, country
    FROM events
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT 60
  `).bind(...params).all();

  return {
    generatedAt: new Date().toISOString(),
    days,
    totals: normalizeRow(totals),
    funnel: normalizeRow(funnel),
    byDay: byDay.results || [],
    bySource: bySource.results || [],
    byCampaign: byCampaign.results || [],
    downloads: downloads.results || [],
    checkouts: checkouts.results || [],
    latest: latest.results || []
  };
}

function renderDashboard(data, days) {
  const totals = data.totals || {};
  const funnel = data.funnel || {};
  const maxFunnel = Math.max(Number(funnel.viewed || 0), 1);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Toolshelf Analytics</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0e14; --panel:#121722; --panel2:#171d2a; --text:#edf2ff; --muted:#9aa7bd; --line:#283244; --blue:#75a7ff; --green:#6ee7a8; --violet:#a98bff; --red:#ff8b8b; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { padding: 28px 24px 18px; border-bottom: 1px solid var(--line); background: #0e121b; position: sticky; top: 0; z-index: 2; }
    main { padding: 24px; max-width: 1220px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    p { margin: 0; color: var(--muted); }
    a { color: var(--blue); }
    .top { max-width: 1220px; margin: 0 auto; display: flex; justify-content: space-between; gap: 16px; align-items: end; }
    .range { display: flex; gap: 8px; flex-wrap: wrap; }
    .range a { text-decoration: none; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); }
    .range a.active { border-color: var(--blue); background: #1a2945; }
    .grid { display: grid; gap: 14px; }
    .cards { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    .card, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .card strong { display: block; font-size: 28px; margin-top: 6px; }
    .card span, th { color: var(--muted); font-size: 13px; font-weight: 600; }
    .two { grid-template-columns: 1fr 1fr; margin-top: 14px; }
    .full { margin-top: 14px; }
    .funnel-row { display: grid; grid-template-columns: 130px 1fr 56px; gap: 12px; align-items: center; margin: 10px 0; color: var(--muted); }
    .bar { height: 11px; border-radius: 999px; background: #242d3f; overflow: hidden; }
    .bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--violet)); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 10px 8px; vertical-align: top; }
    td { color: #dce6fb; font-size: 14px; }
    code { color: var(--green); }
    .muted { color: var(--muted); }
    .pill { display: inline-flex; padding: 3px 7px; border-radius: 999px; background: var(--panel2); border: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    @media (max-width: 980px) { .cards, .two { grid-template-columns: 1fr 1fr; } .top { display: block; } .range { margin-top: 16px; } }
    @media (max-width: 620px) { main, header { padding-left: 14px; padding-right: 14px; } .cards, .two { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; white-space: nowrap; } }
  </style>
</head>
<body>
  <header>
    <div class="top">
      <div>
        <h1>Toolshelf Analytics</h1>
        <p>Private launch dashboard. Generated ${escapeHtml(formatDate(data.generatedAt))}.</p>
      </div>
      <nav class="range" aria-label="Date range">
        ${[7, 14, 30, 90].map((d) => `<a class="${d === days ? "active" : ""}" href="/admin?days=${d}">${d} days</a>`).join("")}
      </nav>
    </div>
  </header>
  <main>
    <section class="grid cards">
      ${metricCard("Sessions", totals.sessions)}
      ${metricCard("Page Views", totals.page_views)}
      ${metricCard("Ad Landings", totals.ad_landings)}
      ${metricCard("Demo Plays", totals.demo_plays)}
      ${metricCard("Downloads", totals.downloads)}
      ${metricCard("Checkout Clicks", totals.checkout_clicks)}
    </section>

    <section class="grid two">
      <div class="panel">
        <h2>Session Funnel</h2>
        ${funnelBar("Viewed", funnel.viewed, maxFunnel)}
        ${funnelBar("Arrived From Ad", funnel.ad_landed, maxFunnel)}
        ${funnelBar("Played Demo", funnel.played_demo, maxFunnel)}
        ${funnelBar("Clicked Download", funnel.downloaded, maxFunnel)}
        ${funnelBar("Clicked Checkout", funnel.checked_out, maxFunnel)}
        <p class="muted">Purchases still need Polar webhook wiring. For now, this shows intent before Polar.</p>
      </div>
      <div class="panel">
        <h2>Downloads</h2>
        ${renderTable(data.downloads, ["app", "platform", "count"])}
      </div>
    </section>

    <section class="grid two">
      <div class="panel">
        <h2>Sources</h2>
        ${renderTable(data.bySource, ["source", "medium", "sessions", "downloads", "checkout_clicks"])}
      </div>
      <div class="panel">
        <h2>Campaigns</h2>
        ${renderTable(data.byCampaign, ["campaign", "source", "sessions", "downloads", "checkout_clicks"])}
      </div>
    </section>

    <section class="panel full">
      <h2>Checkout Clicks</h2>
      ${renderTable(data.checkouts, ["app", "count"])}
    </section>

    <section class="panel full">
      <h2>Daily Events</h2>
      ${renderTable(data.byDay, ["day", "event_name", "count"])}
    </section>

    <section class="panel full">
      <h2>Latest Events</h2>
      ${renderTable(data.latest, ["created_at", "event_name", "app", "page_path", "source", "campaign", "target_label", "platform", "country"])}
    </section>
  </main>
</body>
</html>`;
}

function metricCard(label, value) {
  return `<div class="card"><span>${escapeHtml(label)}</span><strong>${Number(value || 0)}</strong></div>`;
}

function funnelBar(label, value, max) {
  const count = Number(value || 0);
  const width = Math.round((count / max) * 100);
  return `<div class="funnel-row"><span>${escapeHtml(label)}</span><div class="bar"><span style="width:${width}%"></span></div><strong>${count}</strong></div>`;
}

function renderTable(rows, columns) {
  if (!rows || rows.length === 0) {
    return `<p class="muted">No data yet.</p>`;
  }
  return `<table><thead><tr>${columns.map((c) => `<th>${escapeHtml(labelize(c))}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((c) => `<td>${formatCell(row[c])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function formatCell(value) {
  if (value === null || value === undefined || value === "") return `<span class="muted">-</span>`;
  return escapeHtml(String(value));
}

function labelize(value) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

async function requireAdmin(request, env) {
  const header = request.headers.get("authorization") || "";
  const expectedUser = env.ADMIN_USERNAME || "ryan";
  const expectedPassword = env.DASHBOARD_PASSWORD || "";

  if (!expectedPassword || !header.toLowerCase().startsWith("basic ")) {
    return adminChallenge();
  }

  let user = "";
  let password = "";
  try {
    const decoded = atob(header.slice(6));
    const divider = decoded.indexOf(":");
    user = decoded.slice(0, divider);
    password = decoded.slice(divider + 1);
  } catch {
    return adminChallenge();
  }

  if (user !== expectedUser || !(await safeEqual(password, expectedPassword))) {
    return adminChallenge();
  }

  return null;
}

function adminChallenge() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="Toolshelf Analytics", charset="UTF-8"',
      "cache-control": "no-store"
    }
  });
}

async function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function validateOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = allowedOrigins(env);
  if (allowed.includes(origin)) return null;
  return withCors(json({ ok: false, error: "origin_not_allowed" }, 403), request, env);
}

function withCors(response, request, env) {
  const origin = request.headers.get("origin");
  const allowed = allowedOrigins(env);
  if (origin && allowed.includes(origin)) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("access-control-allow-methods", "POST, OPTIONS");
    response.headers.set("access-control-allow-headers", "content-type");
    response.headers.set("vary", "Origin");
  }
  return response;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function cleanUrl(value) {
  const text = cleanText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    url.hash = "";
    return url.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

function pathFromUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`.slice(0, 160);
  } catch {
    return null;
  }
}

function hostFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "").slice(0, 120);
  } catch {
    return null;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, value || 0]));
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Kentucky/Louisville"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
