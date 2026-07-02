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

const PRODUCT_APPS = {
  "c779ab38-f3c0-4e46-92fb-a40877219aee": "cleancut",
  "8f2c8f91-28e3-499d-8e5d-80e798b78638": "polishkey"
};

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

    if (url.pathname === "/polar/webhook" && request.method === "POST") {
      return handlePolarWebhook(request, env);
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

async function handlePolarWebhook(request, env) {
  if (!env.POLAR_WEBHOOK_SECRET) {
    return json({ ok: false, error: "missing_webhook_secret" }, 500);
  }

  const body = await request.text();
  const valid = await verifyStandardWebhook(request.headers, body, env.POLAR_WEBHOOK_SECRET);
  if (!valid) {
    return json({ ok: false, error: "invalid_signature" }, 403);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const eventType = cleanText(payload.type, 80);
  const eventTimestamp = cleanText(payload.timestamp, 80);
  const data = payload.data || {};
  const orderId = extractOrderId(eventType, data);
  const webhookId = cleanText(request.headers.get("webhook-id"), 160)
    || cleanText(payload.id, 160)
    || `${eventType || "event"}:${orderId || "no-order"}:${eventTimestamp || Date.now()}`;

  const existing = await env.DB.prepare(
    "SELECT webhook_id FROM polar_webhook_events WHERE webhook_id = ?"
  ).bind(webhookId).first();

  if (existing) {
    return json({ ok: true, duplicate: true });
  }

  await env.DB.prepare(`
    INSERT INTO polar_webhook_events (webhook_id, event_type, event_timestamp, order_id, raw_event)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    webhookId,
    eventType,
    eventTimestamp,
    orderId,
    null
  ).run();

  if (eventType === "order.paid" || eventType === "order.updated") {
    await upsertPaidOrder(env, data);
  } else if (eventType === "order.refunded" || eventType === "refund.created" || eventType === "refund.updated") {
    await markRefund(env, eventType, data);
  }

  return json({ ok: true });
}

async function upsertPaidOrder(env, order) {
  const metadata = order.metadata || order.checkout?.metadata || {};
  const productId = cleanText(
    order.product_id || order.product?.id || order.items?.[0]?.product_id || order.items?.[0]?.product?.id,
    80
  );
  const app = inferAppFromOrder(productId, order.product?.name || order.product_name || order.items?.[0]?.product?.name);
  const orderId = cleanText(order.id, 120);
  if (!orderId) return;

  const amount = firstNumber(order.amount, order.total_amount, order.subtotal_amount, order.net_amount);
  const taxAmount = firstNumber(order.tax_amount, order.total_tax_amount);
  const referenceId = cleanText(order.reference_id || metadata.reference_id, 120);
  const source = cleanText(order.utm_source || metadata.utm_source, 80);
  const medium = cleanText(order.utm_medium || metadata.utm_medium, 80);
  const campaign = cleanText(order.utm_campaign || metadata.utm_campaign, 120);
  const term = cleanText(order.utm_term || metadata.utm_term, 120);
  const content = cleanText(order.utm_content || metadata.utm_content, 120);

  await env.DB.prepare(`
    INSERT INTO polar_orders (
      order_id, status, app, product_id, product_name, customer_id,
      amount, tax_amount, currency, reference_id,
      source, medium, campaign, term, content, has_gclid, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      status = excluded.status,
      app = COALESCE(excluded.app, polar_orders.app),
      product_id = COALESCE(excluded.product_id, polar_orders.product_id),
      product_name = COALESCE(excluded.product_name, polar_orders.product_name),
      customer_id = COALESCE(excluded.customer_id, polar_orders.customer_id),
      amount = excluded.amount,
      tax_amount = excluded.tax_amount,
      currency = COALESCE(excluded.currency, polar_orders.currency),
      reference_id = COALESCE(excluded.reference_id, polar_orders.reference_id),
      source = COALESCE(excluded.source, polar_orders.source),
      medium = COALESCE(excluded.medium, polar_orders.medium),
      campaign = COALESCE(excluded.campaign, polar_orders.campaign),
      term = COALESCE(excluded.term, polar_orders.term),
      content = COALESCE(excluded.content, polar_orders.content),
      has_gclid = MAX(excluded.has_gclid, polar_orders.has_gclid),
      metadata = COALESCE(excluded.metadata, polar_orders.metadata)
  `).bind(
    orderId,
    cleanText(order.status || "paid", 40),
    app,
    productId,
    cleanText(order.product?.name || order.product_name || order.items?.[0]?.product?.name, 160),
    null,
    amount,
    taxAmount,
    cleanText(order.currency, 12),
    referenceId,
    source,
    medium,
    campaign,
    term,
    content,
    order.gclid || metadata.gclid ? 1 : 0,
    JSON.stringify(metadata || {}).slice(0, 4000)
  ).run();
}

async function markRefund(env, eventType, data) {
  const order = data.order || data;
  const orderId = extractOrderId(eventType, data);
  if (!orderId) return;
  const refundAmount = firstNumber(data.amount, data.refunded_amount, order.refunded_amount, order.amount);

  await env.DB.prepare(`
    INSERT INTO polar_orders (order_id, status, amount, currency, refunded_at, refund_amount)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
    ON CONFLICT(order_id) DO UPDATE SET
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      status = 'refunded',
      refunded_at = COALESCE(polar_orders.refunded_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      refund_amount = CASE
        WHEN ? > polar_orders.refund_amount THEN ?
        ELSE polar_orders.refund_amount
      END
  `).bind(
    orderId,
    "refunded",
    firstNumber(order.amount),
    cleanText(order.currency || data.currency, 12),
    refundAmount,
    refundAmount,
    refundAmount
  ).run();
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

  const orders = await env.DB.prepare(`
    SELECT
      COUNT(*) AS purchases,
      SUM(CASE WHEN refunded_at IS NULL THEN amount ELSE 0 END) AS gross_revenue,
      SUM(CASE WHEN refunded_at IS NOT NULL THEN 1 ELSE 0 END) AS refunds,
      SUM(refund_amount) AS refunded_amount
    FROM polar_orders
    WHERE created_at >= datetime('now', ?)
  `).bind(...params).first();

  const ordersBySource = await env.DB.prepare(`
    SELECT
      COALESCE(NULLIF(source, ''), 'unknown') AS source,
      COALESCE(NULLIF(medium, ''), '') AS medium,
      COALESCE(NULLIF(campaign, ''), '(none)') AS campaign,
      COUNT(*) AS purchases,
      SUM(CASE WHEN refunded_at IS NULL THEN amount ELSE 0 END) AS gross_revenue
    FROM polar_orders
    WHERE created_at >= datetime('now', ?)
    GROUP BY source, medium, campaign
    ORDER BY gross_revenue DESC, purchases DESC
    LIMIT 20
  `).bind(...params).all();

  const ordersByApp = await env.DB.prepare(`
    SELECT
      COALESCE(NULLIF(app, ''), 'unknown') AS app,
      COUNT(*) AS purchases,
      SUM(CASE WHEN refunded_at IS NULL THEN amount ELSE 0 END) AS gross_revenue,
      SUM(CASE WHEN refunded_at IS NOT NULL THEN 1 ELSE 0 END) AS refunds
    FROM polar_orders
    WHERE created_at >= datetime('now', ?)
    GROUP BY app
    ORDER BY gross_revenue DESC, purchases DESC
  `).bind(...params).all();

  const latestOrders = await env.DB.prepare(`
    SELECT created_at, app, status, product_name, amount, currency, source, medium, campaign, reference_id, refunded_at
    FROM polar_orders
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT 30
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
    orders: normalizeRow(orders),
    ordersBySource: ordersBySource.results || [],
    ordersByApp: ordersByApp.results || [],
    latestOrders: latestOrders.results || [],
    latest: latest.results || []
  };
}

function renderDashboard(data, days) {
  const totals = data.totals || {};
  const funnel = data.funnel || {};
  const orders = data.orders || {};
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
    .cards { grid-template-columns: repeat(8, minmax(0, 1fr)); }
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
      ${metricCard("Purchases", orders.purchases)}
      ${metricCard("Gross Revenue", formatMoney(orders.gross_revenue))}
    </section>

    <section class="grid two">
      <div class="panel">
        <h2>Session Funnel</h2>
        ${funnelBar("Viewed", funnel.viewed, maxFunnel)}
        ${funnelBar("Arrived From Ad", funnel.ad_landed, maxFunnel)}
        ${funnelBar("Played Demo", funnel.played_demo, maxFunnel)}
        ${funnelBar("Clicked Download", funnel.downloaded, maxFunnel)}
        ${funnelBar("Clicked Checkout", funnel.checked_out, maxFunnel)}
        <p class="muted">Checkout clicks show buying intent. Confirmed purchases below come from signed Polar order webhooks.</p>
      </div>
      <div class="panel">
        <h2>Downloads</h2>
        ${renderTable(data.downloads, ["app", "platform", "count"])}
      </div>
    </section>

    <section class="grid two">
      <div class="panel">
        <h2>Purchases By App</h2>
        ${renderTable(data.ordersByApp, ["app", "purchases", "gross_revenue", "refunds"])}
      </div>
      <div class="panel">
        <h2>Purchases By Source</h2>
        ${renderTable(data.ordersBySource, ["source", "medium", "campaign", "purchases", "gross_revenue"])}
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
      <h2>Latest Purchases</h2>
      ${renderTable(data.latestOrders, ["created_at", "app", "status", "product_name", "amount", "currency", "source", "campaign", "reference_id", "refunded_at"])}
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
  return `<div class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? 0))}</strong></div>`;
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
  return `<table><thead><tr>${columns.map((c) => `<th>${escapeHtml(labelize(c))}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((c) => `<td>${formatCell(row[c], c, row)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function formatCell(value, column, row = {}) {
  if (value === null || value === undefined || value === "") return `<span class="muted">-</span>`;
  if (["amount", "gross_revenue", "refund_amount", "refunded_amount"].includes(column)) {
    return escapeHtml(formatMoney(value, row.currency || "USD"));
  }
  return escapeHtml(String(value));
}

function formatMoney(cents, currency = "USD") {
  const amount = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function labelize(value) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

async function verifyStandardWebhook(headers, body, secret) {
  const webhookId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");

  if (!webhookId || !timestamp || !signatureHeader || !secret) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > 5 * 60) {
    return false;
  }

  const signedPayload = `${webhookId}.${timestamp}.${body}`;
  const signatures = signatureHeader
    .split(" ")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part && part !== "v1");

  if (signatures.length === 0) {
    return false;
  }

  const keys = await candidateWebhookKeys(secret);
  for (const key of keys) {
    const expected = await hmacSha256Base64(key, signedPayload);
    if (signatures.some((sig) => timingSafeEqual(sig, expected))) {
      return true;
    }
  }

  return false;
}

async function candidateWebhookKeys(secret) {
  const encoder = new TextEncoder();
  const raw = String(secret);
  const candidates = [encoder.encode(raw), encoder.encode(btoa(raw))];

  const withoutPrefix = raw.startsWith("whsec_") ? raw.slice("whsec_".length) : raw;
  try {
    candidates.push(base64ToBytes(withoutPrefix));
  } catch {
    // The configured Polar secret may be plain text, which is fine.
  }

  return candidates;
}

async function hmacSha256Base64(keyBytes, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64(new Uint8Array(signature));
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function extractOrderId(eventType, data) {
  if (!data) return null;
  if (data.order_id) return cleanText(data.order_id, 120);
  if (data.order?.id) return cleanText(data.order.id, 120);
  if (eventType?.startsWith("order.") && data.id) return cleanText(data.id, 120);
  return null;
}

function inferAppFromOrder(productId, productName) {
  if (productId && PRODUCT_APPS[productId]) return PRODUCT_APPS[productId];
  const name = String(productName || "").toLowerCase();
  if (name.includes("polishkey")) return "polishkey";
  if (name.includes("cleancut")) return "cleancut";
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return Math.round(number);
  }
  return 0;
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
