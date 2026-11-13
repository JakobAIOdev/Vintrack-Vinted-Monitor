// Vintrack features drawn directly into Vinted pages: listing badges, a local
// seen marker with price memory, keyword fading/highlighting, an insights
// panel on item pages and live find toasts.
//
// Nothing here sends a request to Vinted. Listings are matched in the page
// against a snapshot of the member's own Vintrack data, and the seen history
// never leaves the browser.
(function () {
  const extensionApi = globalThis.browser || globalThis.chrome;
  const companion = globalThis.VintrackCompanion;
  const shared = companion?.inline;

  const SEEN_LIMIT = 2000;
  const INDEX_REFRESH_MS = 60 * 1000;
  const INDEX_RETRY_MS = 2 * 60 * 1000;
  const INDEX_UNLINKED_RETRY_MS = 5 * 60 * 1000;
  const TOAST_POLL_MS = 20 * 1000;
  const TOAST_MAX_BACKOFF_MS = 5 * 60 * 1000;
  const TOAST_MAX_AGE_MS = 10 * 60 * 1000;
  const TOAST_VISIBLE_MS = 9000;
  const TOAST_LIMIT = 3;
  // A reload or a quick back-and-forth is not worth a "you opened this" note.
  const REVISIT_NOTE_AFTER_SECONDS = 30 * 60;
  const TOAST_CURSOR_KEY = "vintrackInlineToastCursor";
  const MODE_KEY = "vintrackCompanionMode";

  // ---- Pure helpers (also exercised by scripts/inline.test.mjs) ----------

  // "15,00 €", "£1,234.56", "1 500 Kč" and "5 000 Ft" all become hundredths.
  function parsePriceMinor(text) {
    const match = String(text ?? "")
      .replace(/[\s  ]/g, "")
      .match(/\d[\d.,']*/);
    if (!match) return null;
    const digits = match[0].replace(/[.,']+$/, "");
    const decimal = digits.match(/[.,](\d{1,2})$/);
    const whole = (decimal ? digits.slice(0, decimal.index) : digits).replace(
      /[.,']/g,
      "",
    );
    const minor =
      Number(whole || "0") * 100 +
      Number(decimal ? decimal[1].padEnd(2, "0") : "0");
    return Number.isSafeInteger(minor) ? minor : null;
  }

  function formatMinor(minor, currency, locale) {
    const value = Number(minor) / 100;
    if (!Number.isFinite(value)) return "";
    for (const candidate of [locale, undefined]) {
      try {
        return currency
          ? new Intl.NumberFormat(candidate || undefined, {
              style: "currency",
              currency,
            }).format(value)
          : new Intl.NumberFormat(candidate || undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(value);
      } catch {
        // An unknown page locale or currency falls through to the next form.
      }
    }
    return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }

  function formatDate(epochSeconds, locale, withTime = false) {
    const date = new Date(Number(epochSeconds) * 1000);
    if (!epochSeconds || Number.isNaN(date.getTime())) return "";
    const options = withTime
      ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short" };
    try {
      return new Intl.DateTimeFormat(locale || undefined, options).format(date);
    } catch {
      return new Intl.DateTimeFormat(undefined, options).format(date);
    }
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  // Vinted's card label is "<title>, <Brand label>: <brand>, <Condition
  // label>: ..., <price>". Keywords should only see the title and brand, so a
  // word like "good" does not match every listing in good condition.
  function listingText(cardLabel, brand) {
    const full = String(cardLabel ?? "").trim();
    const brandText = String(brand ?? "").trim();
    if (!full) return brandText;
    if (brandText) {
      const marker = full.lastIndexOf(`: ${brandText},`);
      const cut = marker > 0 ? full.lastIndexOf(", ", marker) : -1;
      if (cut > 0) return `${full.slice(0, cut)} ${brandText}`;
    }
    return full;
  }

  function findKeyword(text, keywords) {
    if (!Array.isArray(keywords) || keywords.length === 0) return "";
    const haystack = normalizeText(text);
    for (const keyword of keywords) {
      const needle = normalizeText(keyword).trim();
      if (needle && haystack.includes(needle)) return keyword;
    }
    return "";
  }

  // Seen entries are [firstSeenSec, lastSeenSec, priceMinor|null, currency].
  function normalizeSeen(raw) {
    const seen = {};
    if (!raw || typeof raw !== "object") return seen;
    for (const [id, entry] of Object.entries(raw)) {
      if (!/^[1-9]\d{0,19}$/.test(id) || !Array.isArray(entry)) continue;
      const first = Number(entry[0]) || 0;
      const last = Number(entry[1]) || first;
      if (!first) continue;
      seen[id] = [
        first,
        last,
        Number.isSafeInteger(entry[2]) && entry[2] > 0 ? entry[2] : null,
        /^[A-Z]{3}$/.test(String(entry[3] || "")) ? entry[3] : "",
      ];
    }
    return seen;
  }

  function rememberVisit(seen, id, nowSeconds, priceMinor, currency, limit) {
    const previous = seen[id];
    const next = { ...seen };
    next[id] = [
      previous?.[0] || nowSeconds,
      nowSeconds,
      priceMinor ?? previous?.[2] ?? null,
      priceMinor ? currency || "" : previous?.[3] || "",
    ];
    const ids = Object.keys(next);
    const max = limit || SEEN_LIMIT;
    if (ids.length > max) {
      ids.sort((left, right) => next[left][1] - next[right][1]);
      for (const stale of ids.slice(0, ids.length - max)) delete next[stale];
    }
    return next;
  }

  function buildIndexMaps(index) {
    const monitorNames = new Map(
      (index?.monitors || []).map((monitor) => [monitor.id, monitor.name]),
    );
    const finds = new Map();
    for (const find of index?.finds || []) {
      // The snapshot is newest first; keep the first entry per listing.
      if (finds.has(find[0])) continue;
      finds.set(find[0], {
        monitorId: find[1],
        monitorName: monitorNames.get(find[1]) || "Vintrack monitor",
        foundAt: find[2],
      });
    }
    const watches = new Map();
    for (const watch of index?.watches || []) {
      if (!watches.has(watch.itemId)) watches.set(watch.itemId, watch);
    }
    return { finds, watches };
  }

  function watchPrices(watch) {
    const initial = watch?.initialPriceMinor
      ? Number(watch.initialPriceMinor)
      : null;
    const current = watch?.currentPriceMinor
      ? Number(watch.currentPriceMinor)
      : null;
    return {
      initial,
      current,
      delta: initial !== null && current !== null ? current - initial : 0,
    };
  }

  // Vintrack reports what it tells the member about a watch ("Sold",
  // "Reserved", ...). Servers that predate this only send the status.
  const ENDED_WATCH_STATES = new Set([
    "sold",
    "removed",
    "unavailable",
    "stopped",
  ]);

  function watchState(watch) {
    const key =
      watch?.stateKey ||
      (watch?.status === "active"
        ? "watching"
        : watch?.status === "stopped"
          ? "stopped"
          : "paused");
    const fallbackLabels = {
      watching: "Watching",
      stopped: "Stopped",
      paused: "Paused",
    };
    return {
      key,
      label: watch?.stateLabel || fallbackLabels[key] || "Watching",
      ended: ENDED_WATCH_STATES.has(key),
      paused: key === "paused",
      // Reserved and hidden listings are still watched, with a caveat.
      caveat: key === "reserved" || key === "hidden",
    };
  }

  function shorten(text, max) {
    const value = String(text ?? "");
    return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
  }

  function percent(delta, base) {
    if (!base) return "";
    const value = Math.round((delta / base) * 100);
    return value === 0 ? "" : `${value > 0 ? "+" : "−"}${Math.abs(value)} %`;
  }

  // What a listing card should show. `context` carries the member's settings,
  // the index maps, the seen history and the page locale.
  function cardModel(card, context) {
    const { settings, maps, seen, locale } = context;
    const money = (minor, currency) => formatMinor(minor, currency, locale);
    const chips = [];
    const model = { chips, muted: "", highlight: "", seen: false };
    if (!settings) return model;

    if (settings.badges && maps) {
      const find = maps.finds.get(card.id);
      if (find) {
        chips.push({
          kind: "found",
          label: shorten(find.monitorName, 22),
          title: `Found by your Vintrack monitor “${find.monitorName}”${
            find.foundAt
              ? ` on ${formatDate(find.foundAt, locale, true)}`
              : ""
          }`,
        });
      }
      const watch = maps.watches.get(card.id);
      if (watch) {
        const prices = watchPrices(watch);
        const state = watchState(watch);
        const quiet = state.ended || state.paused || state.caveat;
        chips.push({
          kind: state.ended
            ? "ended"
            : !quiet && prices.delta < 0
              ? "drop"
              : "watch",
          label: state.ended
            ? state.label
            : state.paused
              ? "Watch paused"
              : state.caveat
                ? `Tracked · ${state.label}`
                : prices.delta < 0
                  ? `Tracked ↓ ${money(-prices.delta, watch.currencyCode)}`
                  : prices.delta > 0
                    ? `Tracked ↑ ${money(prices.delta, watch.currencyCode)}`
                    : "Tracked",
          title: [
            state.ended
              ? `Vintrack Price Watch ended: ${state.label.toLowerCase()}`
              : `Vintrack Price Watch (${state.label.toLowerCase()})`,
            prices.initial !== null
              ? `started at ${money(prices.initial, watch.currencyCode)}`
              : "",
            prices.current !== null
              ? `${state.ended ? "last seen at" : "now"} ${money(prices.current, watch.currencyCode)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
        });
      }
    }

    const entry = settings.seen ? seen?.[card.id] : null;
    if (entry) {
      model.seen = true;
      const dropped =
        entry[2] !== null &&
        card.priceMinor !== null &&
        card.priceMinor !== undefined &&
        card.priceMinor < entry[2];
      // A Price Watch chip already reports the drop; do not say it twice.
      const reported = chips.some((chip) => chip.kind === "drop");
      if (dropped && !reported) {
        chips.push({
          kind: "drop",
          label: `↓ was ${money(entry[2], entry[3])}`,
          title: `Cheaper than when you opened this listing on ${formatDate(entry[1], locale)}`,
        });
      } else if (!dropped) {
        chips.push({
          kind: "seen",
          label: "Seen",
          title: `You opened this listing on ${formatDate(entry[1], locale)}`,
        });
      }
    }

    const muted = findKeyword(card.text, settings.mutedKeywords);
    if (muted) {
      model.muted = muted;
      chips.push({
        kind: "muted",
        label: `Faded · ${shorten(muted, 18)}`,
        title: `Faded by your Vintrack keyword “${muted}”`,
      });
    } else {
      const highlight = findKeyword(card.text, settings.highlightKeywords);
      if (highlight) {
        model.highlight = highlight;
        chips.push({
          kind: "highlight",
          label: `★ ${shorten(highlight, 18)}`,
          title: `Matches your Vintrack keyword “${highlight}”`,
        });
      }
    }
    return model;
  }

  // Rows of the insights panel on an item page.
  function panelModel(page, context) {
    const { settings, maps, locale } = context;
    const money = (minor, currency) => formatMinor(minor, currency, locale);
    const rows = [];
    if (!settings?.itemPanel) return rows;

    const find = maps?.finds.get(page.id);
    if (find) {
      rows.push({
        kind: "found",
        label: "Found by your monitor",
        value: [find.monitorName, formatDate(find.foundAt, locale, true)]
          .filter(Boolean)
          .join(" · "),
        action: { label: "Open monitor", destination: "monitor", id: find.monitorId },
      });
    }

    const watch = maps?.watches.get(page.id);
    if (watch) {
      const prices = watchPrices(watch);
      const change = percent(prices.delta, prices.initial);
      const state = watchState(watch);
      rows.push({
        kind: state.ended ? "ended" : prices.delta < 0 ? "drop" : "watch",
        label: "Price Watch",
        value: [
          state.key === "watching" ? "Active" : state.label,
          prices.initial !== null
            ? `started at ${money(prices.initial, watch.currencyCode)}`
            : "",
          prices.current !== null && prices.delta !== 0
            ? `${state.ended ? "last seen at" : "now"} ${money(prices.current, watch.currencyCode)}${change ? ` (${change})` : ""}`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
        action: { label: "Open watch", destination: "priceWatch", id: watch.id },
      });
    }

    const previous = settings.seen ? page.previous : null;
    if (previous) {
      const price = page.priceMinor ?? null;
      const changed =
        previous[2] !== null && price !== null && price !== previous[2];
      if (changed) {
        const delta = price - previous[2];
        const currency = page.currency || previous[3];
        rows.push({
          kind: delta < 0 ? "drop" : "rise",
          label: `Since your last look on ${formatDate(previous[1], locale)}`,
          value: `${money(previous[2], previous[3] || currency)} → ${money(price, currency)} (${delta < 0 ? "−" : "+"}${money(Math.abs(delta), currency)})`,
        });
      } else if (
        (page.nowSeconds || 0) - previous[1] >=
        REVISIT_NOTE_AFTER_SECONDS
      ) {
        rows.push({
          kind: "seen",
          label: "You opened this before",
          value:
            previous[0] === previous[1]
              ? `On ${formatDate(previous[1], locale)}${previous[2] !== null && price !== null ? " · price unchanged" : ""}`
              : `First on ${formatDate(previous[0], locale)} · last on ${formatDate(previous[1], locale)}${previous[2] !== null && price !== null ? " · price unchanged" : ""}`,
        });
      }
    }
    return rows;
  }

  // Finds that deserve a toast: newer than the cursor, still fresh, oldest
  // first and bounded so a long pause cannot flood the page.
  function selectToasts(items, cursorMs, nowMs) {
    let newest = cursorMs || 0;
    const fresh = [];
    for (const item of Array.isArray(items) ? items : []) {
      const foundAt = Date.parse(item?.found_at || "");
      if (!Number.isFinite(foundAt)) continue;
      if (foundAt > newest) newest = foundAt;
      if (cursorMs && foundAt > cursorMs && nowMs - foundAt < TOAST_MAX_AGE_MS) {
        fresh.push({ ...item, foundAtMs: foundAt });
      }
    }
    fresh.sort((left, right) => left.foundAtMs - right.foundAtMs);
    return { cursor: newest || nowMs, toasts: fresh.slice(-TOAST_LIMIT) };
  }

  globalThis.VintrackInline = {
    parsePriceMinor,
    formatMinor,
    listingText,
    findKeyword,
    normalizeSeen,
    rememberVisit,
    buildIndexMaps,
    cardModel,
    panelModel,
    selectToasts,
  };

  // ---- Page integration ---------------------------------------------------

  const storage = extensionApi?.storage?.local;
  if (
    typeof document === "undefined" ||
    !shared ||
    !storage ||
    !companion.isVintedHost(window.location.hostname)
  ) {
    return;
  }

  const state = {
    ready: false,
    mode: "inline",
    settings: shared.normalizeSettings(null),
    seen: {},
    maps: null,
    visit: null,
  };
  let renderTimer = null;
  let indexRequest = null;
  let indexNextAt = 0;
  let toastHost = null;
  let toastBusy = false;
  let toastNextAt = 0;
  let toastDelay = TOAST_POLL_MS;
  let toastStopped = false;

  function pageLocale() {
    return document.documentElement.lang || undefined;
  }

  function node(tag, className, text) {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  }

  function send(message) {
    try {
      return Promise.resolve(extensionApi.runtime.sendMessage(message)).catch(
        () => null,
      );
    } catch {
      // The extension was reloaded; this page keeps its last state.
      return Promise.resolve(null);
    }
  }

  function setFlag(target, name, value) {
    if (value) {
      if (target.getAttribute(name) !== value) target.setAttribute(name, value);
    } else if (target.hasAttribute(name)) {
      target.removeAttribute(name);
    }
  }

  function currentItemId() {
    const match = window.location.pathname.match(
      /^\/items\/([1-9]\d*)(?:-|\/|$)/,
    );
    return match ? match[1] : "";
  }

  // Vinted publishes the listing as schema.org Product data in the document.
  function readProduct(id) {
    const urlPattern = new RegExp(`/items/${id}(?:[-/?#]|$)`);
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      let data;
      try {
        data = JSON.parse(script.textContent || "");
      } catch {
        continue;
      }
      for (const entry of Array.isArray(data) ? data : [data]) {
        if (
          entry?.["@type"] !== "Product" ||
          !urlPattern.test(String(entry.offers?.url || ""))
        ) {
          continue;
        }
        const price = Math.round(Number(entry.offers.price) * 100);
        const currency = String(entry.offers.priceCurrency || "");
        return {
          priceMinor: Number.isSafeInteger(price) && price > 0 ? price : null,
          currency: /^[A-Z]{3}$/.test(currency) ? currency : "",
        };
      }
    }
    return null;
  }

  function context() {
    const active = state.mode === "inline";
    return {
      settings: active ? state.settings : null,
      maps: state.maps,
      seen: state.seen,
      locale: pageLocale(),
    };
  }

  // ---- Listing cards ------------------------------------------------------

  function chipNode(chip) {
    const created = node("span", "vtk-chip", chip.label);
    created.dataset.kind = chip.kind;
    created.title = chip.title;
    return created;
  }

  function decorateCard(link, id, pageContext) {
    const host = link.parentElement;
    if (!host) return;
    const card = link.closest(`[data-testid="product-item-id-${id}"]`) || host;
    const brand = card.querySelector(
      '[data-testid$="--description-title"]',
    )?.textContent;
    const model = cardModel(
      {
        id,
        text: listingText(link.title, brand),
        priceMinor: parsePriceMinor(
          card.querySelector('[data-testid$="--price-text"]')?.textContent,
        ),
      },
      pageContext,
    );
    const signature = JSON.stringify(model);
    let wrap = null;
    for (const child of host.children) {
      if (child.dataset?.vintrackInline === "badges") wrap = child;
    }
    if (
      card.dataset.vtkSignature === signature &&
      Boolean(wrap) === model.chips.length > 0
    ) {
      return;
    }

    card.dataset.vtkSignature = signature;
    setFlag(card, "data-vtk-muted", model.muted ? "true" : "");
    setFlag(card, "data-vtk-highlight", model.highlight ? "true" : "");
    setFlag(card, "data-vtk-seen", model.seen ? "true" : "");
    if (model.chips.length === 0) {
      wrap?.remove();
      return;
    }
    if (!wrap) {
      wrap = node("div", "vtk-badges");
      wrap.dataset.vintrackInline = "badges";
      // Chips sit above Vinted's overlay link; hand clicks back to it.
      wrap.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          window.open(link.href, "_blank", "noopener");
        } else {
          link.click();
        }
      });
      if (window.getComputedStyle(host).position === "static") {
        host.style.position = "relative";
      }
      host.appendChild(wrap);
    }
    wrap.replaceChildren(...model.chips.map(chipNode));
  }

  function decorateCards(pageContext) {
    const links = document.querySelectorAll(
      'a[data-testid^="product-item-id-"][data-testid$="--overlay-link"]',
    );
    for (const link of links) {
      const match = /^product-item-id-([1-9]\d*)--overlay-link$/.exec(
        link.dataset.testid || "",
      );
      if (match) decorateCard(link, match[1], pageContext);
    }
    return links.length;
  }

  // ---- Item page ----------------------------------------------------------

  function recordVisit(id) {
    if (state.visit?.id !== id) {
      state.visit = {
        id,
        previous: state.seen[id] || null,
        openedAt: Math.floor(Date.now() / 1000),
        stored: false,
        priced: false,
        product: null,
      };
    }
    const visit = state.visit;
    if (!visit.product) visit.product = readProduct(id);
    const price = visit.product?.priceMinor ?? null;
    if (!state.settings.seen || (visit.stored && (visit.priced || !price))) {
      return visit;
    }
    visit.stored = true;
    visit.priced = Boolean(price);
    state.seen = rememberVisit(
      state.seen,
      id,
      Math.floor(Date.now() / 1000),
      price,
      visit.product?.currency,
    );
    // Best effort: a failed write only loses this visit.
    Promise.resolve(storage.set({ [shared.seenKey]: state.seen })).catch(
      () => {},
    );
    return visit;
  }

  function panelNode(rows, signature) {
    const panel = node("section", "vtk-panel");
    panel.dataset.vintrackInline = "item-panel";
    panel.dataset.vtkSignature = signature;
    panel.setAttribute("aria-label", "Vintrack insights");
    const header = node("header", "vtk-panel-header");
    header.append(node("span", "vtk-mark", "V"), node("strong", "", "Vintrack insights"));
    panel.appendChild(header);
    for (const row of rows) {
      const line = node("div", "vtk-row");
      line.dataset.kind = row.kind;
      const copy = node("div", "vtk-row-copy");
      copy.append(node("span", "", row.label), node("strong", "", row.value));
      line.appendChild(copy);
      if (row.action) {
        const button = node("button", "vtk-row-action", row.action.label);
        button.type = "button";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void send({
            type: "VINTRACK_COMPANION_OPEN",
            payload: {
              destination: row.action.destination,
              id: String(row.action.id),
            },
          });
        });
        line.appendChild(button);
      }
      panel.appendChild(line);
    }
    return panel;
  }

  function placePanel(target, slot, rows, signature) {
    let panel = null;
    for (const child of target.children) {
      if (child.dataset?.vintrackInline === "item-panel") panel = child;
    }
    if (rows.length === 0) {
      panel?.remove();
      return;
    }
    if (!panel || panel.dataset.vtkSignature !== signature) {
      const next = panelNode(rows, signature);
      if (panel) panel.replaceWith(next);
      panel = next;
    }
    // Sit right below the existing "Track price" button when it is present.
    const button = target.querySelector(
      `:scope > [data-vintrack-companion-button="${slot}"]`,
    );
    if (button) {
      if (button.nextElementSibling !== panel) button.after(panel);
    } else if (target.firstElementChild !== panel) {
      target.prepend(panel);
    }
  }

  function renderItemPage(pageContext) {
    const id = currentItemId();
    const targets = [
      [
        document.querySelector(
          '[data-testid="item-desktops-only-container"] #sidebar',
        ) || document.querySelector("main.item-information #sidebar"),
        "item-desktop",
      ],
      [
        document.querySelector('[data-testid="item-mobiles-only-container"]'),
        "item-mobile",
      ],
    ];
    if (!id || !pageContext.settings) {
      if (!id) state.visit = null;
      for (const stray of document.querySelectorAll(
        '[data-vintrack-inline="item-panel"]',
      )) {
        stray.remove();
      }
      return;
    }

    const visit = recordVisit(id);
    const rows = panelModel(
      {
        id,
        previous: visit.previous,
        nowSeconds: visit.openedAt,
        priceMinor: visit.product?.priceMinor ?? null,
        currency: visit.product?.currency || "",
      },
      pageContext,
    );
    const signature = JSON.stringify([id, rows]);
    for (const [target, slot] of targets) {
      if (target) placePanel(target, slot, rows, signature);
    }
  }

  // ---- Vintrack index -----------------------------------------------------

  function refreshIndex() {
    if (
      indexRequest ||
      document.visibilityState !== "visible" ||
      Date.now() < indexNextAt
    ) {
      return;
    }
    indexNextAt = Date.now() + INDEX_REFRESH_MS;
    indexRequest = send({ type: "VINTRACK_INLINE_INDEX" })
      .then((response) => {
        if (response?.ok && response.index) {
          state.maps = buildIndexMaps(response.index);
          scheduleRender(0);
        } else if (response?.ok && response.configured === false) {
          state.maps = null;
          indexNextAt = Date.now() + INDEX_UNLINKED_RETRY_MS;
          scheduleRender(0);
        } else {
          indexNextAt = Date.now() + INDEX_RETRY_MS;
        }
      })
      .finally(() => {
        indexRequest = null;
      });
  }

  // ---- Live find toasts ---------------------------------------------------

  function dismissToast(toast) {
    window.clearTimeout(toast.vtkTimer);
    toast.remove();
    if (toastHost && toastHost.childElementCount === 0) {
      toastHost.remove();
      toastHost = null;
    }
  }

  function armToast(toast, delay) {
    window.clearTimeout(toast.vtkTimer);
    toast.vtkTimer = window.setTimeout(() => dismissToast(toast), delay);
  }

  function showToast(item) {
    const href = companion.safeVintedUrl(item.url);
    if (!href) return;
    if (!toastHost || !toastHost.isConnected) {
      toastHost = node("div", "vtk-toasts");
      toastHost.dataset.vintrackInline = "toasts";
      toastHost.setAttribute("role", "status");
      (document.body || document.documentElement).appendChild(toastHost);
    }

    const toast = node("div", "vtk-toast");
    const link = node("a", "vtk-toast-link");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    let imageUrl = "";
    try {
      const parsed = new URL(String(item.image_url || ""));
      if (parsed.protocol === "https:") imageUrl = parsed.href;
    } catch {
      // No usable image; the placeholder below is shown instead.
    }
    if (imageUrl) {
      const image = node("img", "vtk-toast-thumb");
      image.alt = "";
      image.src = imageUrl;
      image.addEventListener("error", () => image.remove(), { once: true });
      link.appendChild(image);
    }
    const copy = node("span", "vtk-toast-copy");
    copy.append(
      node("small", "", `New find · ${item.monitor_name || "Vintrack"}`),
      node("strong", "", item.title || `Vinted item ${item.id}`),
      node("span", "", item.total_price || item.price || ""),
    );
    link.appendChild(copy);
    link.addEventListener("click", () => dismissToast(toast));

    const close = node("button", "vtk-toast-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => dismissToast(toast));

    toast.append(link, close);
    toast.addEventListener("mouseenter", () =>
      window.clearTimeout(toast.vtkTimer),
    );
    toast.addEventListener("mouseleave", () => armToast(toast, 4000));
    toastHost.appendChild(toast);
    armToast(toast, TOAST_VISIBLE_MS);
  }

  function clearToasts() {
    if (!toastHost) return;
    for (const toast of [...toastHost.children]) dismissToast(toast);
  }

  async function pollToasts() {
    if (
      toastBusy ||
      toastStopped ||
      state.mode !== "inline" ||
      !state.settings.toasts ||
      document.visibilityState !== "visible" ||
      Date.now() < toastNextAt
    ) {
      return;
    }
    toastBusy = true;
    try {
      const response = await send({ type: "VINTRACK_INLINE_FEED" });
      if (!response?.ok) {
        // An unlinked browser or a disabled feed will not recover on its own.
        if (response?.status === 401 || response?.status === 403) {
          toastStopped = true;
        }
        toastDelay = Math.min(toastDelay * 2, TOAST_MAX_BACKOFF_MS);
        return;
      }
      toastDelay = TOAST_POLL_MS;
      if (response.configured === false) {
        toastStopped = true;
        return;
      }
      const stored = await storage.get(TOAST_CURSOR_KEY);
      const cursor = Number(stored?.[TOAST_CURSOR_KEY]) || 0;
      const selection = selectToasts(response.items, cursor, Date.now());
      if (selection.cursor !== cursor) {
        await storage.set({ [TOAST_CURSOR_KEY]: selection.cursor });
      }
      const openItem = currentItemId();
      for (const item of selection.toasts) {
        if (String(item.id) !== openItem) showToast(item);
      }
    } catch {
      toastDelay = Math.min(toastDelay * 2, TOAST_MAX_BACKOFF_MS);
    } finally {
      toastBusy = false;
      toastNextAt = Date.now() + toastDelay;
    }
  }

  // ---- Lifecycle ----------------------------------------------------------

  function render() {
    if (!state.ready) return;
    const pageContext = context();
    const cards = decorateCards(pageContext);
    renderItemPage(pageContext);
    if (
      pageContext.settings &&
      (pageContext.settings.badges || pageContext.settings.itemPanel) &&
      (cards > 0 || currentItemId())
    ) {
      refreshIndex();
    }
    if (!pageContext.settings?.toasts) clearToasts();
  }

  function scheduleRender(delay = 200) {
    if (renderTimer) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      render();
    }, delay);
  }

  function start() {
    if (state.ready) return;
    state.ready = true;
    new MutationObserver(() => scheduleRender()).observe(
      document.documentElement,
      { childList: true, subtree: true },
    );
    window.addEventListener("popstate", () => scheduleRender());
    document.addEventListener("visibilitychange", () => {
      scheduleRender();
      void pollToasts();
    });
    window.setInterval(() => scheduleRender(), INDEX_REFRESH_MS);
    window.setInterval(() => void pollToasts(), 5000);
    scheduleRender(0);
    void pollToasts();
  }

  extensionApi.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[MODE_KEY]) {
      state.mode = changes[MODE_KEY].newValue === "popup" ? "popup" : "inline";
    }
    if (changes[shared.settingsKey]) {
      state.settings = shared.normalizeSettings(
        changes[shared.settingsKey].newValue,
      );
      toastStopped = false;
    }
    if (changes[shared.seenKey]) {
      state.seen = normalizeSeen(changes[shared.seenKey].newValue);
    }
    if (changes[MODE_KEY] || changes[shared.settingsKey] || changes[shared.seenKey]) {
      scheduleRender(0);
    }
  });

  Promise.resolve(
    storage.get([MODE_KEY, shared.settingsKey, shared.seenKey]),
  )
    .catch(() => ({}))
    .then((stored) => {
      state.mode = stored?.[MODE_KEY] === "popup" ? "popup" : "inline";
      state.settings = shared.normalizeSettings(stored?.[shared.settingsKey]);
      state.seen = normalizeSeen(stored?.[shared.seenKey]);

      // Vinted hydrates its server-rendered markup; wait for that to settle
      // before adding nodes, but do not hang on slow subresources.
      if (document.readyState === "complete") {
        window.setTimeout(start, 300);
        return;
      }
      window.addEventListener("load", () => window.setTimeout(start, 300), {
        once: true,
      });
      const afterParse = () => window.setTimeout(start, 1500);
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", afterParse, { once: true });
      } else {
        afterParse();
      }
    });
})();
