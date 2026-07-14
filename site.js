const menuButton = document.querySelector(".menu-toggle");
const menu = document.querySelector(".nav-links");

if (menuButton && menu) {
  menuButton.addEventListener("click", () => {
    const isOpen = menu.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(isOpen));
    document.body.classList.toggle("menu-open", isOpen);
  });

  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menu.classList.remove("open");
      menuButton.setAttribute("aria-expanded", "false");
      document.body.classList.remove("menu-open");
    });
  });
}

if (window.lucide) {
  window.lucide.createIcons({
    attrs: {
      "aria-hidden": "true",
      "stroke-width": 1.8
    }
  });
}

(() => {
  const endpoint = "https://toolshelf-analytics.envelopes-app-com.workers.dev/track";
  const sessionKey = "toolshelf_analytics_session";
  const campaignKey = "toolshelf_analytics_campaign";
  const playedVideos = new WeakSet();

  if (!endpoint || !window.fetch || !window.sessionStorage) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const campaign = readCampaign(params);
  const storedCampaign = readStoredCampaign();
  const activeCampaign = campaign.hasCampaign ? campaign : storedCampaign;

  if (campaign.hasCampaign) {
    sessionStorage.setItem(campaignKey, JSON.stringify(campaign));
  }

  track("page_view", {
    app: inferPageApp(),
    ...activeCampaign
  });

  if (campaign.hasCampaign && isPaidLanding(campaign)) {
    track("ad_landing", {
      app: inferPageApp(),
      ...campaign
    });
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;

    const click = classifyLink(link);
    if (!click) return;

    if (click.kind === "checkout") {
      decorateCheckoutLink(link, activeCampaign);
    }

    track(click.event, {
      app: click.app || inferPageApp(),
      targetUrl: link.href,
      targetLabel: cleanText(link.textContent, 160),
      targetKind: click.kind,
      platform: click.platform,
      ...activeCampaign
    });
  }, { capture: true });

  document.querySelectorAll("video").forEach((video) => {
    video.addEventListener("play", () => {
      if (playedVideos.has(video)) return;
      playedVideos.add(video);
      track("demo_play", {
        app: inferVideoApp(video),
        targetLabel: video.getAttribute("aria-label") || "Demo video",
        targetKind: "video",
        ...activeCampaign
      });
    });
  });

  function track(eventName, extra = {}) {
    const body = JSON.stringify({
      event: eventName,
      pageUrl: window.location.href,
      pagePath: `${window.location.pathname}${window.location.search}`,
      referrer: document.referrer || null,
      referrerHost: hostFromUrl(document.referrer),
      sessionId: getSessionId(),
      device: getDeviceType(),
      language: navigator.language || null,
      ...extra
    });

    try {
      fetch(endpoint, {
        method: "POST",
        mode: "cors",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body
      }).catch(() => {});
    } catch {
      // Analytics should never affect the website experience.
    }
  }

  function getSessionId() {
    let id = sessionStorage.getItem(sessionKey);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(sessionKey, id);
    }
    return id;
  }

  function readCampaign(searchParams) {
    const hasGclid = searchParams.has("gclid");
    const source = cleanText(searchParams.get("utm_source"), 80) || (hasGclid ? "google_ads" : null);
    const medium = cleanText(searchParams.get("utm_medium"), 80) || (hasGclid ? "cpc" : null);
    const campaign = cleanText(searchParams.get("utm_campaign"), 120);
    const term = cleanText(searchParams.get("utm_term"), 120);
    const content = cleanText(searchParams.get("utm_content"), 120);

    return {
      source,
      medium,
      campaign,
      term,
      content,
      hasGclid,
      hasCampaign: Boolean(source || medium || campaign || term || content || hasGclid)
    };
  }

  function readStoredCampaign() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(campaignKey) || "{}");
      return stored && stored.hasCampaign ? stored : {};
    } catch {
      return {};
    }
  }

  function isPaidLanding(campaign) {
    const medium = String(campaign.medium || "").toLowerCase();
    return campaign.hasGclid || ["cpc", "ppc", "paid", "paid_search", "display"].includes(medium);
  }

  function classifyLink(link) {
    const href = link.href || "";

    if (href.startsWith("mailto:")) {
      return { event: "support_email_click", kind: "support_email" };
    }

    if (href.includes("cleancut-updates/releases/latest/download")) {
      return {
        event: "download_click",
        app: "cleancut",
        kind: "download",
        platform: href.includes("CleanCut-Intel") ? "intel_mac" : "apple_silicon"
      };
    }

    if (href.includes("polishkey-updates/releases/latest/download")) {
      return {
        event: "download_click",
        app: "polishkey",
        kind: "download",
        platform: "apple_silicon"
      };
    }

    if (href.includes("apps.apple.com") && href.includes("id6782375480")) {
      return {
        event: "download_click",
        app: "envelopes",
        kind: "app_store",
        platform: "ios_app_store"
      };
    }

    if (href.includes("buy.polar.sh")) {
      return {
        event: "checkout_click",
        app: href.includes("Xf1NA04") ? "polishkey" : "cleancut",
        kind: "checkout"
      };
    }

    try {
      const url = new URL(href);
      if (url.hostname !== window.location.hostname) {
        return { event: "external_click", kind: "external" };
      }
    } catch {
      return null;
    }

    return null;
  }

  function decorateCheckoutLink(link, campaignData = {}) {
    try {
      const url = new URL(link.href);
      url.searchParams.set("reference_id", getSessionId());

      const mapping = {
        source: "utm_source",
        medium: "utm_medium",
        campaign: "utm_campaign",
        content: "utm_content",
        term: "utm_term"
      };

      Object.entries(mapping).forEach(([key, param]) => {
        if (campaignData[key]) {
          url.searchParams.set(param, campaignData[key]);
        }
      });

      link.href = url.toString();
    } catch {
      // Leave the original checkout URL untouched if URL parsing fails.
    }
  }

  function inferPageApp() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes("envelopes")) return "envelopes";
    if (path.includes("polishkey")) return "polishkey";
    if (path.endsWith("/") || path.includes("index.html")) return "cleancut";
    return "toolshelf";
  }

  function inferVideoApp(video) {
    const source = video.querySelector("source")?.getAttribute("src") || "";
    if (source.includes("polishkey")) return "polishkey";
    if (source.includes("cleancut")) return "cleancut";
    return inferPageApp();
  }

  function getDeviceType() {
    if (window.matchMedia("(max-width: 700px)").matches) return "mobile";
    if (window.matchMedia("(max-width: 1024px)").matches) return "tablet";
    return "desktop";
  }

  function hostFromUrl(value) {
    if (!value) return null;
    try {
      return new URL(value).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function cleanText(value, maxLength) {
    if (!value) return null;
    const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    return text ? text.slice(0, maxLength) : null;
  }
})();
