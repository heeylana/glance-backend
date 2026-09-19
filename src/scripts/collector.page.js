// Runs inside the page under test. Mirror of glance-extension-app/lib/adapters.ts `collectContext`
// (types stripped, YouTube caption buffer omitted): what the content script sends to POST /glance.
// Keep in sync when the adapters change.
(() => {
  function detectSite(url = location.href) {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (h === "x.com" || h === "twitter.com" || h === "mobile.twitter.com") return "x";
    if (h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be") return "youtube";
    if (document.querySelector("article, [itemtype*='Article'], meta[property='article:published_time']")) return "article";
    return "generic";
  }
  const TEXT_CAP = 4000;
  const ARTICLE_CAP = 8000;
  const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > -window.innerHeight && r.top < window.innerHeight * 2 && r.width > 0 && r.height > 0;
  }
  function visibleText(root = document.body, cap = TEXT_CAP) {
    const blocks = Array.from(root.querySelectorAll("h1,h2,h3,p,li,blockquote,figcaption,[data-testid='tweetText'],yt-formatted-string,span[dir]"));
    const mid = window.innerHeight / 2;
    const scored = blocks
      .filter((el) => isVisible(el) && !el.closest("nav,footer,aside,[role='navigation'],[aria-hidden='true'],glance-bubble"))
      .map((el) => ({ el, d: Math.abs(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 - mid) }))
      .sort((a, b) => a.d - b.d);
    const seen = new Set();
    let out = "";
    for (const { el } of scored) {
      const t = clean(el.innerText);
      if (t.length < 3 || seen.has(t)) continue;
      seen.add(t);
      if (out.length + t.length + 1 > cap) break;
      out += (out ? "\n" : "") + t;
    }
    if (!out) out = clean(document.body.innerText).slice(0, cap);
    return out;
  }
  function readableText(cap, root, seed) {
    const blocks = Array.from(root.querySelectorAll("h1,h2,h3,p,li,blockquote,figcaption,td,[data-testid='tweetText'],yt-formatted-string,span[dir]"));
    const seen = new Set(seed ? seed.split("\n") : []);
    let out = seed;
    for (const el of blocks) {
      if (el.closest("nav,footer,aside,[role='navigation'],[aria-hidden='true'],glance-bubble")) continue;
      const t = clean(el.innerText);
      if (t.length < 3 || seen.has(t)) continue;
      seen.add(t);
      if (out.length + t.length + 1 > cap) break;
      out += (out ? "\n" : "") + t;
    }
    return out || clean(document.body.innerText).slice(0, cap);
  }
  function meta(name) {
    const el = document.querySelector("meta[property='" + name + "'], meta[name='" + name + "'], meta[itemprop='" + name + "']");
    return el?.content || undefined;
  }
  function statusIdOf(href) {
    const m = href?.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }
  function pickFocalTweet(tweets, mid, pageStatusId) {
    if (pageStatusId) {
      const focal = tweets.find((t) => t.statusId === pageStatusId);
      if (focal) return focal;
    }
    return tweets.filter((t) => t.visible).sort((a, b) => Math.abs(a.top + a.height / 2 - mid) - Math.abs(b.top + b.height / 2 - mid))[0];
  }
  function xAdapter() {
    const tweets = Array.from(document.querySelectorAll("article[data-testid='tweet']")).map((el) => {
      const r = el.getBoundingClientRect();
      return { el, statusId: statusIdOf(el.querySelector("a[href*='/status/']")?.getAttribute("href")), top: r.top, height: r.height, visible: isVisible(el) };
    });
    const t = pickFocalTweet(tweets, window.innerHeight / 2, statusIdOf(location.pathname))?.el;
    if (!t) return {};
    const text = clean(t.querySelector("[data-testid='tweetText']")?.innerText);
    const time = t.querySelector("time")?.dateTime;
    const link = t.querySelector("a[href*='/status/']")?.href;
    return { text, publishedAt: time, url: link ?? location.href, title: text.slice(0, 120) };
  }
  function youtubeAdapter() {
    const title = clean(document.querySelector("h1.ytd-watch-metadata, h1.title, #title h1")?.innerText) || clean(document.title.replace(/ - YouTube$/, ""));
    const description = clean(document.querySelector("#description-inline-expander, #description")?.innerText).slice(0, 1500);
    const published = meta("datePublished") ?? meta("uploadDate") ?? undefined;
    return { title, text: [title, description].filter(Boolean).join("\n"), publishedAt: published };
  }
  function articleAdapter() {
    const title = meta("og:title") ?? clean(document.querySelector("h1")?.textContent) ?? document.title;
    const published = meta("article:published_time") ?? meta("datePublished") ?? document.querySelector("article time[datetime], time[datetime]")?.dateTime;
    const root = document.querySelector("article, main, [role='main']") ?? document.body;
    return { title, text: readableText(ARTICLE_CAP, root, visibleText(root)), publishedAt: published, url: document.querySelector("link[rel='canonical']")?.href ?? location.href };
  }
  function collectContext() {
    const site = detectSite();
    const base = { url: location.href, title: document.title, site, text: "" };
    const part = site === "x" ? xAdapter() : site === "youtube" ? youtubeAdapter() : articleAdapter();
    const merged = { ...base, ...part };
    if (!merged.text || merged.text.length < 20) merged.text = visibleText();
    return merged;
  }
  return JSON.stringify(collectContext());
})()
