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

const APP_EVENT_NAMES = new Set([
  "app_first_launch",
  "app_launch",
  "video_completed",
  "trial_completed",
  "trial_limit_reached",
  "checkout_opened",
  "license_activated"
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

    if (url.pathname === "/app/track" && request.method === "POST") {
      return trackAppEvent(request, env);
    }

    if (url.pathname === "/polar/webhook" && request.method === "POST") {
      return handlePolarWebhook(request, env);
    }

    if ((url.pathname === "/api/ad-snapshots" || url.pathname === "/api/ad-snapshot") && request.method === "POST") {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return upsertAdSnapshots(request, env);
    }

    if (url.pathname === "/api/google-ads/import" && request.method === "POST") {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const result = await importGoogleAds(env);
      if ((request.headers.get("accept") || "").includes("text/html")) {
        return Response.redirect(`${url.origin}/admin?googleAdsImport=${encodeURIComponent(result.status)}`, 303);
      }
      return json(result, result.ok ? 200 : 500);
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
      const notice = url.searchParams.get("savedAdSnapshots")
        ? { kind: "notice", message: `Saved ${url.searchParams.get("savedAdSnapshots")} ad snapshot${url.searchParams.get("savedAdSnapshots") === "1" ? "" : "s"}.` }
        : url.searchParams.get("googleAdsImport")
          ? googleAdsImportNotice(url.searchParams.get("googleAdsImport"))
        : null;
      return html(renderDashboard(summary, days, { notice }));
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(importGoogleAds(env));
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

async function trackAppEvent(request, env) {
  const corsDenied = validateOrigin(request, env);
  if (corsDenied) return corsDenied;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return withCors(json({ ok: false, error: "invalid_json" }, 400), request, env);
  }

  const eventName = cleanText(payload.event, 64);
  const app = cleanText(payload.app, 40);
  const installId = cleanInstallId(payload.installId || payload.install_id);
  if (!APP_EVENT_NAMES.has(eventName)) {
    return withCors(json({ ok: false, error: "invalid_event" }, 400), request, env);
  }
  if (app !== "cleancut" || !installId) {
    return withCors(json({ ok: false, error: "invalid_app_install" }, 400), request, env);
  }

  const cf = request.cf || {};
  await env.DB.prepare(`
    INSERT INTO app_events (
      event_name, app, install_id, app_version, platform, architecture,
      is_licensed, video_count, total_videos_processed, action_mode,
      country, colo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    eventName,
    app,
    installId,
    cleanText(payload.appVersion || payload.app_version, 40),
    cleanText(payload.platform, 40),
    cleanText(payload.architecture, 40),
    payload.licensed ? 1 : 0,
    clampNumber(payload.videoCount ?? payload.video_count, 0, 10000, 0),
    clampNumber(
      payload.totalVideosProcessed ?? payload.total_videos_processed,
      0,
      1000000,
      0
    ),
    cleanText(payload.actionMode || payload.action_mode, 80),
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

async function upsertAdSnapshots(request, env) {
  const contentType = request.headers.get("content-type") || "";
  const wantsHtml = (request.headers.get("accept") || "").includes("text/html")
    && !contentType.includes("application/json");

  let payload;
  try {
    if (contentType.includes("application/json")) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      payload = Object.fromEntries(form.entries());
    }
  } catch {
    return json({ ok: false, error: "invalid_payload" }, 400);
  }

  const inputs = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.snapshots)
      ? payload.snapshots
      : [payload];

  if (inputs.length === 0) {
    return json({ ok: false, error: "no_snapshots" }, 400);
  }

  let saved = 0;
  const rows = [];

  for (const input of inputs) {
    const row = normalizeAdSnapshot(input);
    if (row.error) {
      return json({ ok: false, error: row.error }, 400);
    }

    await saveAdSnapshot(env, row);
    saved += 1;
    rows.push(row);
  }

  if (wantsHtml) {
    const url = new URL(request.url);
    return Response.redirect(`${url.origin}/admin?savedAdSnapshots=${saved}`, 303);
  }

  return json({ ok: true, saved, snapshots: rows });
}

async function saveAdSnapshot(env, row) {
  await env.DB.prepare(`
    INSERT INTO ad_snapshots (
      snapshot_date, platform, account_id, campaign_key, campaign_id, campaign_name,
      app, source, medium, campaign, impressions, clicks, cost_micros,
      cost_currency, conversions, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, platform, campaign_key) DO UPDATE SET
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      account_id = excluded.account_id,
      campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name,
      app = excluded.app,
      source = excluded.source,
      medium = excluded.medium,
      campaign = excluded.campaign,
      impressions = excluded.impressions,
      clicks = excluded.clicks,
      cost_micros = excluded.cost_micros,
      cost_currency = excluded.cost_currency,
      conversions = excluded.conversions,
      raw_data = excluded.raw_data
  `).bind(
    row.snapshotDate,
    row.platform,
    row.accountId,
    row.campaignKey,
    row.campaignId,
    row.campaignName,
    row.app,
    row.source,
    row.medium,
    row.campaign,
    row.impressions,
    row.clicks,
    row.costMicros,
    row.costCurrency,
    row.conversions,
    row.rawData
  ).run();
}

function normalizeAdSnapshot(input = {}) {
  const platform = cleanText(input.platform || "google_ads", 40);
  const source = cleanText(input.source || (platform === "google_ads" ? "google" : null), 80);
  const medium = cleanText(input.medium || (platform === "google_ads" ? "cpc" : null), 80);
  const app = cleanText(input.app, 40);
  const campaign = cleanText(input.campaign || input.utm_campaign, 120);
  const accountId = cleanText(input.accountId || input.account_id, 80);
  const campaignId = cleanText(input.campaignId || input.campaign_id, 120);
  const campaignName = cleanText(input.campaignName || input.campaign_name, 160);
  const snapshotDate = cleanDate(input.snapshotDate || input.snapshot_date || input.date);
  const impressions = wholeNumber(input.impressions);
  const clicks = wholeNumber(input.clicks);
  const costMicros = input.costMicros !== undefined
    ? wholeNumber(input.costMicros)
    : input.cost_micros !== undefined
      ? wholeNumber(input.cost_micros)
      : moneyToMicros(input.spend ?? input.cost);
  const costCurrency = cleanText(input.costCurrency || input.cost_currency || input.currency || "USD", 12) || "USD";
  const conversions = decimalNumber(input.conversions);
  const campaignKey = cleanText(
    input.campaignKey
      || input.campaign_key
      || [app || "unknown_app", accountId, campaignId || campaignName || campaign || "unknown_campaign"].filter(Boolean).join(":"),
    220
  );

  if (!snapshotDate) return { error: "invalid_snapshot_date" };
  if (!campaignKey) return { error: "missing_campaign_key" };

  return {
    snapshotDate,
    platform,
    accountId,
    campaignKey,
    campaignId,
    campaignName,
    app,
    source,
    medium,
    campaign,
    impressions,
    clicks,
    costMicros,
    costCurrency,
    conversions,
    rawData: JSON.stringify(input || {}).slice(0, 8000)
  };
}

async function importGoogleAds(env, options = {}) {
  const missing = missingGoogleAdsConfig(env);
  if (missing.length > 0) {
    const result = {
      ok: false,
      status: "missing_config",
      imported: 0,
      message: `Missing Google Ads secrets: ${missing.join(", ")}`
    };
    if (options.recordMissing) await recordGoogleAdsImportRun(env, result);
    return result;
  }

  try {
    const accessToken = await getGoogleAdsAccessToken(env);
    const rows = await fetchGoogleAdsRows(env, accessToken);
    let imported = 0;

    for (const item of rows) {
      const row = normalizeAdSnapshot(item);
      if (!row.error) {
        await saveAdSnapshot(env, row);
        imported += 1;
      }
    }

    const result = {
      ok: true,
      status: "success",
      imported,
      message: `Imported ${imported} Google Ads campaign/day rows.`
    };
    await recordGoogleAdsImportRun(env, result);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      status: "error",
      imported: 0,
      message: cleanText(error?.message || "Google Ads import failed.", 500),
      rawError: cleanText(error?.stack || error?.message || String(error), 4000)
    };
    await recordGoogleAdsImportRun(env, result);
    return result;
  }
}

function missingGoogleAdsConfig(env) {
  return [
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID"
  ].filter((key) => !cleanText(env[key], 4000));
}

async function getGoogleAdsAccessToken(env) {
  const body = new URLSearchParams();
  body.set("client_id", env.GOOGLE_ADS_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_ADS_CLIENT_SECRET);
  body.set("refresh_token", env.GOOGLE_ADS_REFRESH_TOKEN);
  body.set("grant_type", "refresh_token");

  const response = await fetch("https://www.googleapis.com/oauth2/v3/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`Google OAuth failed: ${data.error_description || data.error || response.status}`);
  }

  return data.access_token;
}

async function fetchGoogleAdsRows(env, accessToken) {
  const customerId = normalizeCustomerId(env.GOOGLE_ADS_CUSTOMER_ID);
  const apiVersion = cleanText(env.GOOGLE_ADS_API_VERSION || "v24", 12);
  const response = await fetch(`https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers: googleAdsHeaders(env, accessToken),
    body: JSON.stringify({ query: googleAdsMetricsQuery() })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = googleAdsErrorMessage(data) || `HTTP ${response.status}`;
    throw new Error(`Google Ads API failed: ${errorMessage}`);
  }

  return googleAdsResponsesToSnapshots(env, Array.isArray(data) ? data : [data]);
}

function googleAdsHeaders(env, accessToken) {
  const headers = {
    "authorization": `Bearer ${accessToken}`,
    "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "content-type": "application/json"
  };
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  }
  return headers;
}

function googleAdsMetricsQuery() {
  return `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY segments.date DESC
  `.replace(/\s+/g, " ").trim();
}

function googleAdsResponsesToSnapshots(env, responses) {
  const snapshots = [];

  for (const response of responses) {
    for (const result of response?.results || []) {
      const campaignName = result.campaign?.name || "";
      const app = inferAppFromCampaignName(campaignName, env);
      snapshots.push({
        snapshotDate: result.segments?.date,
        platform: "google_ads",
        accountId: normalizeCustomerId(env.GOOGLE_ADS_CUSTOMER_ID),
        campaignId: result.campaign?.id,
        campaignName,
        app,
        source: "google",
        medium: "cpc",
        campaign: campaignNameToUtmCampaign(app, campaignName, env),
        impressions: result.metrics?.impressions,
        clicks: result.metrics?.clicks,
        costMicros: result.metrics?.costMicros ?? result.metrics?.cost_micros,
        costCurrency: env.GOOGLE_ADS_CURRENCY || "USD",
        conversions: result.metrics?.conversions,
        rawData: result
      });
    }
  }

  return snapshots;
}

function inferAppFromCampaignName(campaignName, env) {
  const name = String(campaignName || "").toLowerCase();
  if (name.includes("polish")) return "polishkey";
  if (name.includes("clean")) return "cleancut";
  return cleanText(env.GOOGLE_ADS_DEFAULT_APP || "cleancut", 40);
}

function campaignNameToUtmCampaign(app, campaignName, env) {
  if (app === "polishkey") return env.GOOGLE_ADS_POLISHKEY_CAMPAIGN || "polishkey_search_test";
  if (app === "cleancut") return env.GOOGLE_ADS_CLEANCUT_CAMPAIGN || env.GOOGLE_ADS_DEFAULT_CAMPAIGN || "cleancut_search_test";
  return cleanText(campaignName, 120) || "(none)";
}

async function recordGoogleAdsImportRun(env, result) {
  try {
    await env.DB.prepare(`
      INSERT INTO google_ads_import_runs (status, imported_snapshots, message, raw_error)
      VALUES (?, ?, ?, ?)
    `).bind(
      cleanText(result.status, 40) || "unknown",
      wholeNumber(result.imported),
      cleanText(result.message, 500),
      cleanText(result.rawError, 4000)
    ).run();
  } catch {
    // If the status table has not been migrated yet, do not break the importer.
  }
}

function googleAdsErrorMessage(data) {
  const error = data?.error;
  const details = error?.details?.flatMap((detail) => detail.errors || []) || [];
  const detailed = details.map((item) => item.message).filter(Boolean).join("; ");
  return detailed || error?.message || null;
}

function normalizeCustomerId(value) {
  return String(value || "").replace(/[^0-9]/g, "");
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

  const appTotals = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT install_id) AS active_installs,
      COUNT(DISTINCT CASE WHEN event_name = 'app_first_launch' THEN install_id END) AS new_installs,
      COALESCE(SUM(CASE WHEN event_name = 'video_completed' THEN video_count ELSE 0 END), 0) AS videos_processed,
      COUNT(DISTINCT CASE WHEN event_name = 'trial_completed' THEN install_id END) AS trials_completed,
      COUNT(DISTINCT CASE WHEN event_name = 'trial_limit_reached' THEN install_id END) AS trial_limit_installs,
      COUNT(DISTINCT CASE WHEN event_name = 'checkout_opened' THEN install_id END) AS app_checkouts,
      COUNT(DISTINCT CASE WHEN event_name = 'license_activated' THEN install_id END) AS activations
    FROM app_events
    WHERE created_at >= datetime('now', ?)
  `).bind(...params).first();

  const appFunnel = await env.DB.prepare(`
    WITH install_flags AS (
      SELECT
        install_id,
        MAX(CASE WHEN event_name IN ('app_first_launch', 'app_launch') THEN 1 ELSE 0 END) AS launched,
        SUM(CASE WHEN event_name = 'video_completed' THEN video_count ELSE 0 END) AS videos,
        MAX(CASE WHEN event_name IN ('trial_completed', 'trial_limit_reached') THEN 1 ELSE 0 END) AS reached_trial_end,
        MAX(CASE WHEN event_name = 'checkout_opened' THEN 1 ELSE 0 END) AS opened_checkout,
        MAX(CASE WHEN event_name = 'license_activated' THEN 1 ELSE 0 END) AS activated
      FROM app_events
      WHERE created_at >= datetime('now', ?)
      GROUP BY install_id
    )
    SELECT
      SUM(launched) AS launched,
      SUM(CASE WHEN videos >= 1 THEN 1 ELSE 0 END) AS processed_one,
      SUM(CASE WHEN videos >= 3 THEN 1 ELSE 0 END) AS processed_three,
      SUM(reached_trial_end) AS reached_trial_end,
      SUM(opened_checkout) AS opened_checkout,
      SUM(activated) AS activated
    FROM install_flags
  `).bind(...params).first();

  const appInstalls = await env.DB.prepare(`
    SELECT
      substr(install_id, 1, 8) || '...' AS install,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen,
      MAX(app_version) AS app_version,
      MAX(platform) AS platform,
      MAX(architecture) AS architecture,
      MAX(total_videos_processed) AS total_videos,
      MAX(is_licensed) AS licensed,
      MAX(CASE WHEN event_name IN ('trial_completed', 'trial_limit_reached') THEN 1 ELSE 0 END) AS trial_end,
      MAX(CASE WHEN event_name = 'checkout_opened' THEN 1 ELSE 0 END) AS checkout_opened
    FROM app_events
    WHERE created_at >= datetime('now', ?)
    GROUP BY install_id
    ORDER BY last_seen DESC
    LIMIT 50
  `).bind(...params).all();

  const appToolUsage = await env.DB.prepare(`
    SELECT
      COALESCE(NULLIF(action_mode, ''), 'unknown') AS tool_selection,
      COUNT(DISTINCT install_id) AS installs,
      SUM(video_count) AS videos
    FROM app_events
    WHERE created_at >= datetime('now', ?) AND event_name = 'video_completed'
    GROUP BY action_mode
    ORDER BY videos DESC
  `).bind(...params).all();

  const latestAppEvents = await env.DB.prepare(`
    SELECT
      created_at,
      substr(install_id, 1, 8) || '...' AS install,
      event_name,
      app_version,
      platform,
      architecture,
      video_count,
      total_videos_processed,
      action_mode,
      is_licensed,
      country
    FROM app_events
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT 80
  `).bind(...params).all();

  const adSummary = await getAdSummary(env, days);

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
    latest: latest.results || [],
    appTotals: normalizeRow(appTotals),
    appFunnel: normalizeRow(appFunnel),
    appInstalls: appInstalls.results || [],
    appToolUsage: appToolUsage.results || [],
    latestAppEvents: latestAppEvents.results || [],
    ...adSummary
  };
}

async function getAdSummary(env, days) {
  const params = [`-${days} days`];

  try {
    const adTotals = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(impressions), 0) AS ad_impressions,
        COALESCE(SUM(clicks), 0) AS ad_clicks,
        COALESCE(SUM(cost_micros), 0) AS ad_cost_micros,
        COALESCE(SUM(conversions), 0) AS ad_conversions,
        CASE
          WHEN COALESCE(SUM(impressions), 0) > 0 THEN ROUND((SUM(clicks) * 100.0) / SUM(impressions), 2)
          ELSE 0
        END AS ad_ctr_percent,
        CASE
          WHEN COALESCE(SUM(clicks), 0) > 0 THEN ROUND(SUM(cost_micros) / SUM(clicks))
          ELSE 0
        END AS avg_cpc_micros,
        COALESCE(MAX(cost_currency), 'USD') AS cost_currency
      FROM ad_snapshots
      WHERE snapshot_date >= date('now', ?)
    `).bind(...params).first();

    const adByCampaign = await env.DB.prepare(`
      WITH ads AS (
        SELECT
          COALESCE(NULLIF(app, ''), 'unknown') AS app,
          COALESCE(NULLIF(source, ''), 'unknown') AS source,
          COALESCE(NULLIF(medium, ''), '') AS medium,
          COALESCE(NULLIF(campaign, ''), '(none)') AS campaign,
          COALESCE(NULLIF(campaign_name, ''), '(unnamed)') AS campaign_name,
          COALESCE(MAX(cost_currency), 'USD') AS cost_currency,
          SUM(impressions) AS impressions,
          SUM(clicks) AS clicks,
          SUM(cost_micros) AS cost_micros,
          SUM(conversions) AS conversions
        FROM ad_snapshots
        WHERE snapshot_date >= date('now', ?)
        GROUP BY app, source, medium, campaign, campaign_name
      ),
      web AS (
        SELECT
          COALESCE(NULLIF(app, ''), 'unknown') AS app,
          COALESCE(NULLIF(source, ''), CASE WHEN has_gclid = 1 THEN 'google' END, 'unknown') AS source,
          COALESCE(NULLIF(medium, ''), CASE WHEN has_gclid = 1 THEN 'cpc' END, '') AS medium,
          COALESCE(NULLIF(campaign, ''), '(none)') AS campaign,
          COUNT(DISTINCT session_id) AS sessions,
          SUM(CASE WHEN event_name = 'ad_landing' THEN 1 ELSE 0 END) AS ad_landings,
          SUM(CASE WHEN event_name = 'download_click' THEN 1 ELSE 0 END) AS downloads,
          SUM(CASE WHEN event_name = 'checkout_click' THEN 1 ELSE 0 END) AS checkout_clicks
        FROM events
        WHERE created_at >= datetime('now', ?)
        GROUP BY app, source, medium, campaign
      ),
      orders AS (
        SELECT
          COALESCE(NULLIF(app, ''), 'unknown') AS app,
          COALESCE(NULLIF(source, ''), 'unknown') AS source,
          COALESCE(NULLIF(medium, ''), '') AS medium,
          COALESCE(NULLIF(campaign, ''), '(none)') AS campaign,
          COUNT(*) AS purchases,
          SUM(CASE WHEN refunded_at IS NULL THEN amount ELSE 0 END) AS gross_revenue
        FROM polar_orders
        WHERE created_at >= datetime('now', ?)
        GROUP BY app, source, medium, campaign
      )
      SELECT
        ads.app,
        ads.source,
        ads.medium,
        ads.campaign,
        ads.campaign_name,
        ads.impressions,
        ads.clicks,
        CASE
          WHEN ads.impressions > 0 THEN ROUND((ads.clicks * 100.0) / ads.impressions, 2)
          ELSE 0
        END AS ctr_percent,
        CASE
          WHEN ads.clicks > 0 THEN ROUND(ads.cost_micros / ads.clicks)
          ELSE 0
        END AS avg_cpc_micros,
        ads.cost_micros,
        ads.cost_currency,
        ads.conversions,
        COALESCE(web.sessions, 0) AS sessions,
        COALESCE(web.ad_landings, 0) AS ad_landings,
        COALESCE(web.downloads, 0) AS downloads,
        COALESCE(web.checkout_clicks, 0) AS checkout_clicks,
        COALESCE(orders.purchases, 0) AS purchases,
        COALESCE(orders.gross_revenue, 0) AS gross_revenue
      FROM ads
      LEFT JOIN web
        ON web.app = ads.app
        AND web.source = ads.source
        AND web.medium = ads.medium
        AND web.campaign = ads.campaign
      LEFT JOIN orders
        ON orders.app = ads.app
        AND orders.source = ads.source
        AND orders.medium = ads.medium
        AND orders.campaign = ads.campaign
      ORDER BY ads.cost_micros DESC, ads.clicks DESC
      LIMIT 30
    `).bind(...params, ...params, ...params).all();

    const latestAdSnapshots = await env.DB.prepare(`
      SELECT
        snapshot_date, platform, app, campaign_name, source, medium, campaign,
        impressions, clicks, cost_micros, cost_currency, conversions, updated_at
      FROM ad_snapshots
      WHERE snapshot_date >= date('now', ?)
      ORDER BY snapshot_date DESC, updated_at DESC
      LIMIT 30
    `).bind(...params).all();

    const latestGoogleAdsImport = await getLatestGoogleAdsImport(env);

    return {
      adTotals: normalizeRow(adTotals),
      adByCampaign: adByCampaign.results || [],
      latestAdSnapshots: latestAdSnapshots.results || [],
      latestGoogleAdsImport,
      googleAdsConfig: googleAdsConfigStatus(env),
      adWarning: null
    };
  } catch (error) {
    return {
      adTotals: normalizeRow({}),
      adByCampaign: [],
      latestAdSnapshots: [],
      latestGoogleAdsImport: null,
      googleAdsConfig: googleAdsConfigStatus(env),
      adWarning: "Run the latest D1 schema migration to enable ad spend tracking."
    };
  }
}

async function getLatestGoogleAdsImport(env) {
  try {
    return await env.DB.prepare(`
      SELECT created_at, status, imported_snapshots, message
      FROM google_ads_import_runs
      ORDER BY created_at DESC
      LIMIT 1
    `).first();
  } catch {
    return null;
  }
}

function googleAdsConfigStatus(env) {
  const missing = missingGoogleAdsConfig(env);
  return {
    configured: missing.length === 0,
    missing
  };
}

function googleAdsImportNotice(status) {
  if (status === "success") {
    return { kind: "notice", message: "Google Ads import finished successfully." };
  }
  if (status === "missing_config") {
    return { kind: "warning", message: "Google Ads is not connected yet. Add the Google Ads API secrets before importing real ad spend and paid-click data." };
  }
  return { kind: "warning", message: `Google Ads import finished with status: ${status || "unknown"}.` };
}

function renderDashboard(data, days, options = {}) {
  const totals = data.totals || {};
  const funnel = data.funnel || {};
  const orders = data.orders || {};
  const adTotals = data.adTotals || {};
  const appTotals = data.appTotals || {};
  const appFunnel = data.appFunnel || {};
  const maxFunnel = Math.max(Number(funnel.viewed || 0), 1);
  const maxAppFunnel = Math.max(Number(appFunnel.launched || 0), 1);
  const today = new Date().toISOString().slice(0, 10);

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
    .cards { grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); }
    .card, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .card strong { display: block; font-size: 28px; margin-top: 6px; }
    .card span, th { color: var(--muted); font-size: 13px; font-weight: 600; }
    .two { grid-template-columns: 1fr 1fr; margin-top: 14px; }
    .full { margin-top: 14px; }
    .notice { margin: 0 0 14px; padding: 12px 14px; border: 1px solid #315741; background: #112619; border-radius: 8px; color: var(--green); }
    .warning { margin: 0 0 14px; padding: 12px 14px; border: 1px solid #614d25; background: #2b2110; border-radius: 8px; color: #ffd28b; }
    .funnel-row { display: grid; grid-template-columns: 130px 1fr 56px; gap: 12px; align-items: center; margin: 10px 0; color: var(--muted); }
    .bar { height: 11px; border-radius: 999px; background: #242d3f; overflow: hidden; }
    .bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--violet)); }
    .snapshot-form { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
    .snapshot-form label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; font-weight: 700; }
    .snapshot-form input, .snapshot-form select, .snapshot-form button { min-width: 0; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; background: #0d121c; color: var(--text); font: inherit; }
    .snapshot-form button { cursor: pointer; background: #1b3159; border-color: #416aa7; font-weight: 800; }
    .inline-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .inline-actions button { border: 1px solid #416aa7; border-radius: 8px; padding: 9px 12px; background: #1b3159; color: var(--text); font: inherit; font-weight: 800; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 10px 8px; vertical-align: top; }
    td { color: #dce6fb; font-size: 14px; }
    code { color: var(--green); }
    .muted { color: var(--muted); }
    .pill { display: inline-flex; padding: 3px 7px; border-radius: 999px; background: var(--panel2); border: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    @media (max-width: 980px) { .cards, .two, .snapshot-form { grid-template-columns: 1fr 1fr; } .top { display: block; } .range { margin-top: 16px; } }
    @media (max-width: 620px) { main, header { padding-left: 14px; padding-right: 14px; } .cards, .two, .snapshot-form { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; white-space: nowrap; } }
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
    ${options.notice ? `<div class="${escapeHtml(options.notice.kind || "notice")}">${escapeHtml(options.notice.message || options.notice)}</div>` : ""}
    ${data.adWarning ? `<div class="warning">${escapeHtml(data.adWarning)}</div>` : ""}
    <section class="grid cards">
      ${metricCard("Sessions", totals.sessions)}
      ${metricCard("Page Views", totals.page_views)}
      ${metricCard("Tagged Landings", totals.ad_landings)}
      ${metricCard("Google Ads Spend", formatMicrosMoney(adTotals.ad_cost_micros, adTotals.cost_currency || "USD"))}
      ${metricCard("Google Ads Clicks", adTotals.ad_clicks)}
      ${metricCard("Google Ads Impr.", adTotals.ad_impressions)}
      ${metricCard("Google Avg CPC", formatMicrosMoney(adTotals.avg_cpc_micros, adTotals.cost_currency || "USD"))}
      ${metricCard("Demo Plays", totals.demo_plays)}
      ${metricCard("Downloads", totals.downloads)}
      ${metricCard("Checkout Clicks", totals.checkout_clicks)}
      ${metricCard("Purchases", orders.purchases)}
      ${metricCard("Gross Revenue", formatMoney(orders.gross_revenue))}
    </section>

    <section class="panel full">
      <h2>Google Ads Connection</h2>
      ${renderGoogleAdsStatus(data.googleAdsConfig, data.latestGoogleAdsImport)}
      <div class="inline-actions">
        <form method="post" action="/api/google-ads/import">
          <button type="submit">Import Google Ads Now</button>
        </form>
        <p class="muted">Auto-import runs every 6 hours once Google Ads secrets are set.</p>
      </div>
      <p class="muted" style="margin-top:12px">Tagged landings are website visits with Google/CPC tracking parameters. Google Ads clicks, impressions, spend, and CPC come from the Google Ads API or the fallback snapshot form below.</p>
      ${renderAdSnapshotForm(today)}
    </section>

    <section class="grid two">
      <div class="panel">
        <h2>Session Funnel</h2>
        ${funnelBar("Viewed", funnel.viewed, maxFunnel)}
        ${funnelBar("Tagged Landing", funnel.ad_landed, maxFunnel)}
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

    <section class="panel full">
      <h2>CleanCut In-App Usage</h2>
      <p class="muted">Anonymous install IDs only. CleanCut never sends video files, filenames, transcripts, detected words, license keys, names, or email addresses.</p>
      <div class="grid cards" style="margin-top:16px">
        ${metricCard("Active Installs", appTotals.active_installs)}
        ${metricCard("New Installs", appTotals.new_installs)}
        ${metricCard("Videos Processed", appTotals.videos_processed)}
        ${metricCard("Completed Trials", appTotals.trials_completed)}
        ${metricCard("Trial Limit Reached", appTotals.trial_limit_installs)}
        ${metricCard("App Checkouts", appTotals.app_checkouts)}
        ${metricCard("License Activations", appTotals.activations)}
      </div>
    </section>

    <section class="grid two">
      <div class="panel">
        <h2>Install Funnel</h2>
        ${funnelBar("Launched CleanCut", appFunnel.launched, maxAppFunnel)}
        ${funnelBar("Processed 1+ Video", appFunnel.processed_one, maxAppFunnel)}
        ${funnelBar("Processed 3+ Videos", appFunnel.processed_three, maxAppFunnel)}
        ${funnelBar("Reached Trial End", appFunnel.reached_trial_end, maxAppFunnel)}
        ${funnelBar("Opened Checkout", appFunnel.opened_checkout, maxAppFunnel)}
        ${funnelBar("Activated License", appFunnel.activated, maxAppFunnel)}
      </div>
      <div class="panel">
        <h2>Tool Combinations</h2>
        ${renderTable(data.appToolUsage, ["tool_selection", "installs", "videos"])}
      </div>
    </section>

    <section class="panel full">
      <h2>Anonymous Installs</h2>
      ${renderTable(data.appInstalls, ["install", "first_seen", "last_seen", "app_version", "platform", "architecture", "total_videos", "trial_end", "checkout_opened", "licensed"])}
    </section>

    <section class="panel full">
      <h2>Latest In-App Events</h2>
      ${renderTable(data.latestAppEvents, ["created_at", "install", "event_name", "app_version", "platform", "architecture", "video_count", "total_videos_processed", "action_mode", "is_licensed", "country"])}
    </section>

    <section class="panel full">
      <h2>Google Ads API / Snapshots</h2>
      ${renderTable(data.adByCampaign, ["app", "source", "medium", "campaign", "campaign_name", "impressions", "clicks", "ctr_percent", "avg_cpc_micros", "cost_micros", "sessions", "ad_landings", "downloads", "checkout_clicks", "purchases", "gross_revenue"])}
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
      <h2>Latest Ad Snapshots</h2>
      ${renderTable(data.latestAdSnapshots, ["snapshot_date", "platform", "app", "campaign_name", "source", "medium", "campaign", "impressions", "clicks", "cost_micros", "cost_currency", "conversions", "updated_at"])}
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

function renderAdSnapshotForm(today) {
  return `<form class="snapshot-form" method="post" action="/api/ad-snapshots">
    <label>Date <input type="date" name="snapshot_date" value="${escapeHtml(today)}" required></label>
    <label>App <select name="app"><option value="cleancut">CleanCut</option><option value="polishkey">PolishKey</option></select></label>
    <label>Campaign Name <input name="campaign_name" value="Campaign #1" autocomplete="off"></label>
    <label>UTM Campaign <input name="campaign" value="cleancut_search_test" autocomplete="off"></label>
    <label>Impressions <input name="impressions" type="number" min="0" step="1" value="0"></label>
    <label>Clicks <input name="clicks" type="number" min="0" step="1" value="0"></label>
    <label>Spend <input name="cost" type="number" min="0" step="0.01" value="0.00"></label>
    <label>Currency <input name="cost_currency" value="USD" autocomplete="off"></label>
    <input type="hidden" name="platform" value="google_ads">
    <input type="hidden" name="source" value="google">
    <input type="hidden" name="medium" value="cpc">
    <button type="submit">Save Snapshot</button>
  </form>`;
}

function renderGoogleAdsStatus(config = {}, latestImport = null) {
  if (!config.configured) {
    return `<p class="warning">Google Ads API is not connected yet. Missing: ${escapeHtml((config.missing || []).join(", ") || "credentials")}.</p>`;
  }

  const latest = latestImport
    ? `Last import: ${escapeHtml(formatDate(latestImport.created_at))}, ${escapeHtml(latestImport.status)}, ${escapeHtml(String(latestImport.imported_snapshots || 0))} rows. ${escapeHtml(latestImport.message || "")}`
    : "Google Ads API credentials are configured. No import has run yet.";

  return `<p class="notice">${latest}</p>`;
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
  if (["cost_micros", "avg_cpc_micros", "ad_cost_micros"].includes(column)) {
    return escapeHtml(formatMicrosMoney(value, row.cost_currency || "USD"));
  }
  if (column === "ctr_percent") {
    return escapeHtml(`${Number(value || 0).toFixed(2)}%`);
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

function formatMicrosMoney(micros, currency = "USD") {
  const amount = Number(micros || 0) / 1000000;
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
  const labels = {
    ad_landings: "Tagged Landings",
    avg_cpc_micros: "Avg CPC",
    cost_micros: "Spend",
    gross_revenue: "Gross Revenue",
    checkout_clicks: "Checkout Clicks"
  };
  if (labels[value]) return labels[value];
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

function wholeNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function decimalNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(number) || number < 0) return 0;
  return number;
}

function moneyToMicros(value) {
  const number = Number(String(value ?? "").replace(/[$,]/g, ""));
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 1000000);
}

function cleanDate(value) {
  const text = cleanText(value || new Date().toISOString().slice(0, 10), 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
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

function cleanInstallId(value) {
  const text = cleanText(value, 64);
  if (!text || !/^[a-f0-9]{32}$/i.test(text)) return null;
  return text.toLowerCase();
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
