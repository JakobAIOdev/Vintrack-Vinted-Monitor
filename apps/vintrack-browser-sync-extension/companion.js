(function () {
  const extensionApi = globalThis.browser || globalThis.chrome;
  const VINTED_DOMAINS = new Set([
    "vinted.at",
    "vinted.be",
    "vinted.co.uk",
    "vinted.com",
    "vinted.cz",
    "vinted.de",
    "vinted.dk",
    "vinted.es",
    "vinted.fi",
    "vinted.fr",
    "vinted.hr",
    "vinted.hu",
    "vinted.ie",
    "vinted.it",
    "vinted.lt",
    "vinted.lu",
    "vinted.nl",
    "vinted.pl",
    "vinted.pt",
    "vinted.ro",
    "vinted.se",
    "vinted.sk",
  ]);

  let nextInstanceId = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function send(message) {
    if (!extensionApi?.runtime?.sendMessage) {
      return Promise.resolve({
        ok: false,
        error: "Extension context unavailable. Reload the extension.",
      });
    }
    try {
      return Promise.resolve(extensionApi.runtime.sendMessage(message)).catch(
        (error) => ({
          ok: false,
          error: error?.message || "Extension request failed.",
        }),
      );
    } catch (error) {
      return Promise.resolve({
        ok: false,
        error: error?.message || "Extension context unavailable.",
      });
    }
  }

  function formatTimestamp(value) {
    if (!value) return "Not yet";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Not yet"
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date);
  }

  function formatPrice(minor, currency) {
    if (minor === null || minor === undefined || !currency) return "—";
    const value = Number(minor) / 100;
    if (!Number.isFinite(value)) return "—";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${currency}`;
    }
  }

  function safeVintedUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      return url.protocol === "https:" && VINTED_DOMAINS.has(host)
        ? url.href
        : "";
    } catch {
      return "";
    }
  }

  function shortcutLabel() {
    const platform = String(
      navigator.userAgentData?.platform ||
        navigator.platform ||
        navigator.userAgent ||
        "",
    );
    return /mac|iphone|ipad/i.test(platform)
      ? "Option + Shift + V"
      : "Alt + Shift + V";
  }

  function addButton(parent, label, action, options = {}) {
    const button = element(
      "button",
      options.secondary ? "vtc-button vtc-button-secondary" : "vtc-button",
      label,
    );
    button.type = "button";
    button.dataset.action = action;
    if (options.id) button.dataset.id = String(options.id);
    if (options.kind) button.dataset.kind = options.kind;
    if (options.destination) button.dataset.destination = options.destination;
    if (options.url) button.dataset.url = options.url;
    parent.appendChild(button);
    return button;
  }

  function emptyState(title, copy) {
    const box = element("div", "vtc-empty");
    box.append(element("strong", "", title), element("p", "", copy));
    return box;
  }

  async function copyText(value, root) {
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const input = element("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.cssText =
        "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;";
      root.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      return copied;
    }
  }

  function mountCompanion(container, options = {}) {
    const surface = options.surface === "drawer" ? "drawer" : "popup";
    const root = element("section", `vtc-root vtc-${surface}`);
    const instanceId = `vtc-${surface}-${++nextInstanceId}`;
    const header = element("header", "vtc-header");
    const brand = element("div", "vtc-brand");
    const brandCopy = element("div");
    brandCopy.append(
      element("span", "", "VINTRACK"),
      element("strong", "", "Companion"),
    );
    brand.append(element("span", "vtc-logo", "V"), brandCopy);
    const headerActions = element("div", "vtc-header-actions");
    const refreshButton = element("button", "vtc-icon-button", "↻");
    refreshButton.type = "button";
    refreshButton.dataset.action = "refresh";
    refreshButton.setAttribute("aria-label", "Refresh");
    headerActions.appendChild(refreshButton);
    if (surface === "drawer") {
      const closeButton = element("button", "vtc-icon-button", "×");
      closeButton.type = "button";
      closeButton.dataset.action = "close";
      closeButton.setAttribute("aria-label", "Close");
      headerActions.appendChild(closeButton);
    }
    header.append(brand, headerActions);

    const tabs = element("nav", "vtc-tabs");
    tabs.setAttribute("aria-label", "Companion views");
    tabs.setAttribute("role", "tablist");
    for (const [name, label] of [
      ["overview", "Overview"],
      ["feed", "Feed"],
      ["watches", "Watches"],
    ]) {
      const button = element("button", "", label);
      button.type = "button";
      button.dataset.tab = name;
      button.id = `${instanceId}-tab-${name}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `${instanceId}-panel-${name}`);
      button.tabIndex = name === "overview" ? 0 : -1;
      button.setAttribute(
        "aria-selected",
        name === "overview" ? "true" : "false",
      );
      tabs.appendChild(button);
    }

    const notice = element("div", "vtc-notice");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.setAttribute("aria-atomic", "true");
    const content = element("main", "vtc-content");
    const overviewPanel = element("section");
    overviewPanel.dataset.panel = "overview";
    const feedPanel = element("section");
    feedPanel.dataset.panel = "feed";
    feedPanel.hidden = true;
    const watchesPanel = element("section");
    watchesPanel.dataset.panel = "watches";
    watchesPanel.hidden = true;
    content.append(overviewPanel, feedPanel, watchesPanel);
    for (const panel of [overviewPanel, feedPanel, watchesPanel]) {
      panel.id = `${instanceId}-panel-${panel.dataset.panel}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute(
        "aria-labelledby",
        `${instanceId}-tab-${panel.dataset.panel}`,
      );
      panel.tabIndex = 0;
    }
    overviewPanel.appendChild(
      emptyState(
        "Loading Companion…",
        "Checking your connection and current Vinted page.",
      ),
    );

    const footer = element("footer", "vtc-footer");
    const modeLabel = element("label", "vtc-mode");
    const inlineToggle = element("input");
    inlineToggle.type = "checkbox";
    inlineToggle.disabled = true;
    inlineToggle.dataset.role = "inline-toggle";
    modeLabel.append(
      inlineToggle,
      element("span", "", "Show actions inside Vinted"),
    );
    const version = element("span", "vtc-version");
    const footerMeta = element("div", "vtc-footer-meta");
    const shortcut = element("span", "vtc-shortcut");
    shortcut.title = "Open or close the Vintrack Companion on Vinted";
    shortcut.append(
      element("span", "", "Drawer"),
      element("kbd", "", shortcutLabel()),
    );
    footerMeta.append(shortcut, version);
    footer.append(modeLabel, footerMeta);
    root.append(header, tabs, notice, content, footer);
    container.appendChild(root);
    let state = null;
    let watches = [];
    let nextCursor = null;
    let watchesLoaded = false;
    let busy = false;
    let activeTab = "overview";
    let feedTimer = null;
    let feedBusy = false;
    let lastFeedUpdatedAt = null;
    let watchesError = "";
    let refreshing = false;
    let destroyed = false;

    function featureAllowed(feature) {
      const capability = state?.overview?.capabilities?.[feature];
      return capability ? capability.allowed === true : true;
    }

    function applyCapabilities() {
      const visibility = {
        feed: featureAllowed("live_feed"),
        watches: featureAllowed("price_watch"),
      };
      for (const button of root.querySelectorAll("[data-tab]")) {
        if (button.dataset.tab === "overview") continue;
        button.hidden = visibility[button.dataset.tab] === false;
      }
      if (visibility[activeTab] === false) selectTab("overview");
    }

    function applyTheme(theme) {
      if (theme === "light" || theme === "dark") {
        root.dataset.theme = theme;
      } else {
        delete root.dataset.theme;
      }
    }

    function handleStorageThemeChange(changes, areaName) {
      if (areaName !== "local" || !changes?.vintrackTheme) return;
      applyTheme(changes.vintrackTheme.newValue);
    }

    extensionApi?.storage?.onChanged?.addListener(handleStorageThemeChange);

    function showNotice(message, tone = "error") {
      notice.textContent = message || "";
      notice.dataset.tone = tone;
    }

    function metric(label, value) {
      const card = element("div", "vtc-metric");
      card.append(
        element("span", "", label),
        element("strong", "", String(value)),
      );
      return card;
    }

    function catalogFilterLabels(parsed) {
      if (!parsed) return [];
      const labels = [];
      if (parsed.region)
        labels.push(`Region ${String(parsed.region).toUpperCase()}`);
      if (parsed.priceMin || parsed.priceMax) {
        labels.push(
          `Price ${parsed.priceMin || "0"}–${parsed.priceMax || "any"}`,
        );
      }
      for (const [label, value] of [
        ["Categories", parsed.catalogIds],
        ["Brands", parsed.brandIds],
        ["Sizes", parsed.sizeIds],
        ["Colors", parsed.colorIds],
        ["Conditions", parsed.statusIds],
        ["Platforms", parsed.videoGamePlatformIds],
      ]) {
        if (Array.isArray(value) && value.length) {
          labels.push(`${label} ${value.length}`);
        }
      }
      const extraCount = [...new URLSearchParams(parsed.extraParams || "")]
        .length;
      if (extraCount) labels.push(`More filters ${extraCount}`);
      return labels;
    }

    function renderContext(parent) {
      const context = state?.context;
      const card = element("div", "vtc-card vtc-context-card");
      const actions = element("div", "vtc-context-actions");
      card.appendChild(element("span", "vtc-eyebrow", "ACTIVE VINTED TAB"));
      if (context?.kind === "catalog") {
        card.appendChild(
          element(
            "strong",
            "vtc-card-title",
            context.parsed?.query
              ? `Search: ${context.parsed.query}`
              : "Catalog search",
          ),
        );
        const filterPreview = element("div", "vtc-filter-preview");
        const labels = catalogFilterLabels(context.parsed);
        for (const label of labels.length
          ? labels
          : ["Region and filters detected"]) {
          filterPreview.appendChild(element("span", "vtc-filter-chip", label));
        }
        card.appendChild(filterPreview);
        if (context.matchingMonitor) {
          const badge = element(
            "span",
            "vtc-status vtc-status-ok",
            `Already monitored · ${context.matchingMonitor.status}`,
          );
          card.appendChild(badge);
          addButton(actions, "Open existing monitor", "open", {
            destination: "monitor",
            id: context.matchingMonitor.id,
          });
        } else {
          addButton(actions, "Create monitor for this search", "handoff", {
            kind: "monitor",
          });
        }
        addButton(actions, "Copy clean search link", "copy-context", {
          kind: "catalog",
          secondary: true,
        });
        card.appendChild(actions);
      } else if (context?.kind === "item") {
        card.appendChild(
          element(
            "strong",
            "vtc-card-title",
            `Vinted item ${context.item?.itemId || ""}`,
          ),
        );
        if (context.priceWatch) {
          card.appendChild(
            element(
              "span",
              "vtc-status vtc-status-ok",
              `Already watched · ${context.priceWatch.status}`,
            ),
          );
          addButton(actions, "Open existing Price Watch", "open", {
            destination: "priceWatch",
            id: context.priceWatch.id,
          });
        } else {
          card.appendChild(
            element(
              "p",
              "vtc-muted",
              "Open a prefilled form. Nothing is created automatically.",
            ),
          );
          addButton(actions, "Create Price Watch for this item", "handoff", {
            kind: "priceWatch",
          });
        }
        addButton(actions, "Copy clean item link", "copy-context", {
          kind: "item",
          secondary: true,
        });
        card.appendChild(actions);
      } else {
        card.append(
          element("strong", "vtc-card-title", "Ready for your next find"),
          element(
            "p",
            "vtc-muted",
            "Open a search on Vinted to create a monitor, or an item to track its price.",
          ),
        );
      }
      parent.appendChild(card);
    }

    // Rendering new data must not send keyboard users back to the page body.
    function rememberPanelFocus(panel) {
      const focused = root.getRootNode().activeElement;
      if (!focused || !panel.contains(focused)) return () => {};
      const disclosures = [...panel.querySelectorAll("details")].map(
        (node) => node.open,
      );
      const summaryIndex = [...panel.querySelectorAll("summary")].indexOf(
        focused,
      );
      return () => {
        panel.querySelectorAll("details").forEach((node, index) => {
          node.open = disclosures[index] || false;
        });
        const replacement = focused.dataset.action
          ? [...panel.querySelectorAll("[data-action]")].find((node) =>
              ["action", "id", "destination"].every(
                (key) => node.dataset[key] === focused.dataset[key],
              ),
            )
          : panel.querySelectorAll("summary")[summaryIndex];
        (replacement || panel).focus({ preventScroll: true });
      };
    }

    function renderOverview() {
      const restoreFocus = rememberPanelFocus(overviewPanel);
      overviewPanel.replaceChildren();
      if (state && !state.ok) {
        const error = emptyState(
          "Companion could not load",
          "Check your connection and refresh to try again.",
        );
        addButton(error, "Try again", "refresh", { secondary: true });
        overviewPanel.appendChild(error);
        restoreFocus();
        return;
      }
      if (!state?.configured) {
        const empty = emptyState(
          "Connect Vintrack",
          "Open Account in Vintrack and choose Link With Installed Extension. Then return here to see your monitors and finds.",
        );
        addButton(empty, "Open Vintrack Account", "open", {
          destination: "account",
        });
        overviewPanel.appendChild(empty);
        restoreFocus();
        return;
      }

      const account = state.overview?.account;
      const syncError =
        state.lastSyncStatus === "error" ? state.lastSyncError : "";
      const needsBrowserAction =
        account?.requiresBrowserReauth || state.lastSyncNeedsUserAction;
      const accountStatus = account?.available
        ? account.linked
          ? needsBrowserAction
            ? "Browser refresh needed"
            : syncError
              ? "Sync pending"
              : "Linked"
          : "Not linked"
        : "Status unavailable";
      const statusClass =
        account?.available &&
        account?.linked &&
        !needsBrowserAction &&
        !syncError
          ? "vtc-status vtc-status-ok"
          : "vtc-status";

      renderContext(overviewPanel);

      const links = element("div", "vtc-card vtc-quick-links");
      const moreLinks = element("details", "vtc-disclosure");
      moreLinks.appendChild(element("summary", "", "More destinations"));
      const moreGrid = element("div", "vtc-link-grid");
      links.appendChild(element("span", "vtc-eyebrow", "QUICK LINKS"));
      const grid = element("div", "vtc-link-grid");
      for (const [label, destination, feature] of [
        ["Dashboard", "dashboard", null],
        ["Monitors", "monitors", null],
        ["Notifications", "notifications", null],
        ["Feed", "feed", "live_feed"],
        ["Watches", "priceWatches", "price_watch"],
        ["Chats", "chats", "chats"],
        ["Favorites", "favorites", "liked_items"],
        ["Account", "account", null],
      ]) {
        if (!feature || featureAllowed(feature)) {
          addButton(
            ["dashboard", "monitors", "priceWatches"].includes(destination)
              ? grid
              : moreGrid,
            label,
            "open",
            { destination, secondary: true },
          );
        }
      }
      addButton(moreGrid, "New monitor", "open", {
        destination: "newMonitor",
        secondary: true,
      });
      moreLinks.appendChild(moreGrid);
      links.append(grid, moreLinks);

      const metrics = element("div", "vtc-metrics");
      metrics.append(
        metric("Active monitors", state.overview?.monitors?.active ?? 0),
      );
      if (featureAllowed("price_watch")) {
        metrics.append(
          metric("Price Watches", state.overview?.priceWatches?.total ?? 0),
        );
      }

      const accountCard = element("div", "vtc-card vtc-account-card");
      const accountSummary = element("div", "vtc-account-summary");
      const accountCopy = element("div", "vtc-account-copy");
      accountCopy.append(
        element("span", "vtc-eyebrow", "LINKED ACCOUNT"),
        element(
          "strong",
          "vtc-card-title",
          account?.vintedName || accountStatus,
        ),
        element(
          "p",
          "vtc-muted",
          account?.domain || "Manage your connection in Vintrack Account",
        ),
      );
      accountSummary.append(
        accountCopy,
        element("span", statusClass, accountStatus),
      );
      accountCard.appendChild(accountSummary);
      if (syncError) {
        accountCard.appendChild(element("p", "vtc-muted", syncError));
      }
      const accountActions = element("details", "vtc-disclosure");
      accountActions.open = Boolean(
        needsBrowserAction || syncError || !account?.linked,
      );
      accountActions.appendChild(element("summary", "", "Connection actions"));
      if (needsBrowserAction || !account?.linked) {
        accountActions.appendChild(
          element(
            "p",
            "vtc-muted",
            needsBrowserAction
              ? "Check your login on Vinted, then sync again."
              : "Link your Vinted account in Vintrack to sync this browser.",
          ),
        );
      }
      addButton(accountActions, "Sync linked account now", "sync", {
        secondary: true,
      });
      addButton(accountActions, "Open account settings", "open", {
        destination: "account",
        secondary: true,
      });
      accountCard.appendChild(accountActions);
      if (featureAllowed("vinted_account")) overviewPanel.prepend(accountCard);
      overviewPanel.append(metrics, links);
      restoreFocus();
    }

    function renderFeed() {
      const focused = root.getRootNode().activeElement;
      const hadFocus = focused && feedPanel.contains(focused);
      const focusedHref = hadFocus ? focused.getAttribute("href") : null;
      feedPanel.replaceChildren();
      const items = Array.isArray(state?.overview?.recentFeed)
        ? state.overview.recentFeed
        : [];
      if (!state?.configured) {
        feedPanel.appendChild(
          emptyState(
            "Connect Vintrack",
            "Your recent feed appears after linking.",
          ),
        );
        return;
      }
      const liveRow = element("div", "vtc-live-row");
      const liveStatus = element("span", "vtc-live-status");
      liveStatus.append(
        element("span", "vtc-live-dot"),
        element("strong", "", "Live"),
      );
      liveRow.append(
        liveStatus,
        element(
          "span",
          "vtc-muted",
          lastFeedUpdatedAt
            ? `Updated ${formatTimestamp(lastFeedUpdatedAt)}`
            : "Updates every 12 seconds",
        ),
      );
      feedPanel.appendChild(liveRow);
      if (items.length === 0) {
        feedPanel.appendChild(
          emptyState(
            "No recent finds",
            "New monitor matches will appear here.",
          ),
        );
      }
      const list = element("div", "vtc-list");
      for (const item of items) {
        const href = safeVintedUrl(item.url);
        const card = element(href ? "a" : "div", "vtc-item-card");
        if (href) {
          card.href = href;
          card.target = "_blank";
          card.rel = "noopener noreferrer";
        }
        if (item.image_url) {
          const image = element("img", "vtc-thumb");
          image.src = item.image_url;
          image.alt = "";
          image.loading = "lazy";
          card.appendChild(image);
        } else {
          card.appendChild(element("span", "vtc-thumb vtc-thumb-empty", "V"));
        }
        const copy = element("div", "vtc-item-copy");
        copy.append(
          element("strong", "", item.title || `Vinted item ${item.id}`),
          element(
            "span",
            "",
            item.total_price || item.price || "Price unavailable",
          ),
          element(
            "small",
            "",
            `${item.monitor_name} · ${formatTimestamp(item.found_at)}`,
          ),
        );
        card.appendChild(copy);
        list.appendChild(card);
      }
      feedPanel.appendChild(list);
      const openFeed = addButton(feedPanel, "Open full feed", "open", {
        destination: "feed",
        secondary: true,
      });
      if (focusedHref) {
        const replacement = [...feedPanel.querySelectorAll("a")].find(
          (link) => link.href === focusedHref,
        );
        (replacement || feedPanel).focus({ preventScroll: true });
      } else if (hadFocus && focused?.dataset?.destination === "feed") {
        openFeed.focus({ preventScroll: true });
      }
    }

    async function loadLiveFeed() {
      if (feedBusy || !state?.configured) return;
      feedBusy = true;
      const response = await send({ type: "VINTRACK_COMPANION_FEED" });
      feedBusy = false;
      if (destroyed) return;
      if (!response?.ok) {
        showNotice(
          response?.error || "Live feed temporarily unavailable.",
          "warning",
        );
        return;
      }
      state.overview = {
        ...(state.overview || {}),
        recentFeed: Array.isArray(response.items) ? response.items : [],
      };
      lastFeedUpdatedAt = response.updatedAt || new Date().toISOString();
      renderFeed();
    }

    function stopLiveFeed() {
      if (feedTimer) window.clearInterval(feedTimer);
      feedTimer = null;
    }

    function startLiveFeed() {
      stopLiveFeed();
      if (activeTab !== "feed" || !state?.configured) return;
      void loadLiveFeed();
      feedTimer = window.setInterval(() => void loadLiveFeed(), 12_000);
    }

    function renderWatches() {
      const restoreFocus = rememberPanelFocus(watchesPanel);
      watchesPanel.replaceChildren();
      if (!state?.configured) {
        watchesPanel.appendChild(
          emptyState(
            "Connect Vintrack",
            "Your Price Watches appear after linking.",
          ),
        );
        restoreFocus();
        return;
      }
      if (watchesError && !watches.length) {
        const error = emptyState("Price Watches could not load", watchesError);
        addButton(error, "Try again", "retry-watches", { secondary: true });
        watchesPanel.appendChild(error);
        restoreFocus();
        return;
      }
      if (!watchesLoaded) {
        watchesPanel.appendChild(
          emptyState("Loading…", "Fetching Price Watches."),
        );
        restoreFocus();
        return;
      }
      if (watches.length === 0) {
        const empty = emptyState(
          "No Price Watches",
          "Open a Vinted item and use the Vintrack handoff to prepare one.",
        );
        addButton(empty, "Open Price Watches", "open", {
          destination: "priceWatches",
        });
        watchesPanel.appendChild(empty);
        restoreFocus();
        return;
      }

      const list = element("div", "vtc-list");
      for (const watch of watches) {
        const card = element("article", "vtc-watch-card");
        const top = element("div", "vtc-watch-top");
        if (watch.target?.imageUrl) {
          const image = element("img", "vtc-thumb");
          image.src = watch.target.imageUrl;
          image.alt = "";
          image.loading = "lazy";
          top.appendChild(image);
        }
        const copy = element("div", "vtc-item-copy");
        copy.append(
          element(
            "strong",
            "",
            watch.target?.title || `Vinted item ${watch.target?.itemId || ""}`,
          ),
          element(
            "span",
            "",
            formatPrice(
              watch.target?.currentPriceMinor,
              watch.target?.currencyCode,
            ),
          ),
          element(
            "small",
            "",
            `${watch.status} · ${watch.target?.availability || "pending"}`,
          ),
        );
        top.appendChild(copy);
        card.appendChild(top);
        const actions = element("div", "vtc-watch-actions");
        addButton(
          actions,
          watch.status === "active" ? "Pause" : "Resume",
          "watch-status",
          {
            id: watch.id,
            kind: watch.status === "active" ? "paused" : "active",
            secondary: true,
          },
        );
        addButton(actions, "Open", "open", {
          destination: "priceWatch",
          id: watch.id,
          secondary: true,
        });
        addButton(actions, "Delete", "watch-delete", {
          id: watch.id,
          secondary: true,
        });
        card.appendChild(actions);
        list.appendChild(card);
      }
      watchesPanel.appendChild(list);
      if (nextCursor) {
        if (watchesError)
          watchesPanel.appendChild(
            element(
              "p",
              "vtc-muted",
              "More Price Watches could not load. Your loaded watches are still available.",
            ),
          );
        addButton(
          watchesPanel,
          watchesError ? "Try loading more again" : "Load more",
          "load-more",
          { secondary: true },
        );
      }
      addButton(watchesPanel, "Open all Price Watches", "open", {
        destination: "priceWatches",
        secondary: true,
      });
      restoreFocus();
    }

    function setWatchBusy(value) {
      busy = value;
      watchesPanel.setAttribute("aria-busy", String(value));
      for (const button of watchesPanel.querySelectorAll("button"))
        button.disabled = value;
    }

    async function loadWatches(append = false) {
      if (busy) return;
      setWatchBusy(true);
      const previousError = watchesError;
      watchesError = "";
      const response = await send({
        type: "VINTRACK_COMPANION_PRICE_WATCHES",
        payload: { cursor: append ? nextCursor : "" },
      });
      setWatchBusy(false);
      if (destroyed) return;
      watchesLoaded = true;
      if (!response?.ok) {
        watchesError =
          response?.error || "Check your connection, then try again.";
        showNotice(watchesError);
        renderWatches();
        return;
      }
      if (previousError && notice.textContent === previousError) showNotice("");
      watches = append
        ? [...watches, ...(response.items || [])]
        : response.items || [];
      nextCursor = response.nextCursor || null;
      renderWatches();
    }

    function selectTab(name) {
      const selectedTab = tabs.querySelector(`[data-tab="${name}"]`);
      if (!selectedTab || selectedTab.hidden) return;
      activeTab = name;
      content.scrollTop = 0;
      for (const button of root.querySelectorAll("[data-tab]")) {
        button.setAttribute(
          "aria-selected",
          button.dataset.tab === name ? "true" : "false",
        );
        button.tabIndex = button.dataset.tab === name ? 0 : -1;
      }
      for (const panel of root.querySelectorAll("[data-panel]")) {
        panel.hidden = panel.dataset.panel !== name;
      }
      if (name === "watches" && !watchesLoaded && state?.configured) {
        void loadWatches();
      }
      if (name === "feed") startLiveFeed();
      else stopLiveFeed();
    }

    tabs.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      const visibleTabs = [...tabs.querySelectorAll("[data-tab]")].filter(
        (tab) => !tab.hidden,
      );
      const index = visibleTabs.indexOf(event.target);
      if (index < 0) return;
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? visibleTabs.length - 1
            : (index +
                (event.key === "ArrowRight" ? 1 : -1) +
                visibleTabs.length) %
              visibleTabs.length;
      selectTab(visibleTabs[nextIndex].dataset.tab);
      visibleTabs[nextIndex].focus();
    });

    async function refresh({ clearNotice = true } = {}) {
      if (refreshing || destroyed) return;
      refreshing = true;
      if (clearNotice) showNotice("");
      root.dataset.loading = "true";
      content.setAttribute("aria-busy", "true");
      refreshButton.disabled = true;
      refreshButton.setAttribute("aria-label", "Refreshing Companion");
      const response = await send({ type: "VINTRACK_COMPANION_STATE" });
      refreshing = false;
      if (destroyed) return;
      root.dataset.loading = "false";
      content.setAttribute("aria-busy", "false");
      refreshButton.disabled = false;
      refreshButton.setAttribute("aria-label", "Refresh");
      if (!response?.ok && state?.ok) {
        showNotice(
          response?.error ||
            "Companion could not refresh. Your last update is still shown.",
        );
        return state;
      }
      state = response || { ok: false };
      inlineToggle.disabled = !state.ok;
      applyTheme(state.theme);
      inlineToggle.checked = state.companionMode !== "popup";
      version.textContent = state.version ? `v${state.version}` : "";
      if (!state.ok && state.error) showNotice(state.error);
      if (state.contextError) showNotice(state.contextError, "warning");
      applyCapabilities();
      renderOverview();
      renderFeed();
      renderWatches();
      options.onStateChange?.(state);
      if (activeTab === "feed") startLiveFeed();
      if (activeTab === "watches" && state?.configured && !watchesLoaded)
        void loadWatches();
      return state;
    }

    async function mutateWatch(id, operation) {
      if (busy) return;
      setWatchBusy(true);
      const response = await send({
        type: "VINTRACK_COMPANION_WATCH_MUTATION",
        payload: { id, operation },
      });
      setWatchBusy(false);
      if (!response?.ok) {
        showNotice(response?.error || "Price Watch action failed.");
        return;
      }
      showNotice(
        operation === "delete"
          ? "Price Watch deleted."
          : "Price Watch updated.",
        "ok",
      );
      await loadWatches(false);
      await refresh({ clearNotice: false });
    }

    root.addEventListener("click", async (event) => {
      const target = event.target.closest("button");
      if (!target) return;
      if (target.dataset.tab) {
        selectTab(target.dataset.tab);
        return;
      }
      const action = target.dataset.action;
      if (action === "close") {
        options.onClose?.();
        return;
      }
      if (busy || refreshing) return;
      if (action === "refresh") {
        watchesLoaded = false;
        watchesError = "";
        await refresh();
      } else if (action === "sync") {
        busy = true;
        target.disabled = true;
        target.textContent = "Syncing…";
        const response = await send({
          type: "VINTRACK_COMPANION_MANUAL_SYNC",
        });
        busy = false;
        showNotice(
          response?.ok
            ? "Browser session synced."
            : response?.error || "Sync failed.",
          response?.ok ? "ok" : "error",
        );
        target.disabled = false;
        target.textContent = "Sync linked account now";
        if (response?.ok) await refresh({ clearNotice: false });
      } else if (action === "open") {
        const response = await send({
          type: "VINTRACK_COMPANION_OPEN",
          payload: {
            destination: target.dataset.destination,
            id: target.dataset.id,
          },
        });
        if (!response?.ok)
          showNotice(response?.error || "Could not open Vintrack. Try again.");
      } else if (action === "handoff") {
        const response = await send({
          type: "VINTRACK_COMPANION_HANDOFF",
          payload: { kind: target.dataset.kind },
        });
        if (!response?.ok) showNotice(response?.error || "Handoff failed.");
      } else if (action === "copy-context") {
        const context = state?.context;
        const rawUrl =
          target.dataset.kind === "catalog" && context?.kind === "catalog"
            ? context.handoffUrl
            : target.dataset.kind === "item" && context?.kind === "item"
              ? context.item?.canonicalUrl || context.handoffUrl
              : "";
        const copied = await copyText(safeVintedUrl(rawUrl), root);
        showNotice(
          copied ? "Clean Vinted link copied." : "Could not copy this link.",
          copied ? "ok" : "error",
        );
      } else if (action === "watch-status") {
        await mutateWatch(target.dataset.id, target.dataset.kind);
      } else if (action === "watch-delete") {
        if (
          confirm(
            "Delete this Price Watch? This removes its Vintrack history and cannot be undone.",
          )
        ) {
          await mutateWatch(target.dataset.id, "delete");
        }
      } else if (action === "retry-watches") {
        await loadWatches(false);
      } else if (action === "load-more") {
        await loadWatches(true);
      }
    });

    inlineToggle.addEventListener("change", async () => {
      const mode = inlineToggle.checked ? "inline" : "popup";
      inlineToggle.disabled = true;
      const response = await send({
        type: "VINTRACK_COMPANION_SET_MODE",
        payload: { mode },
      });
      inlineToggle.disabled = false;
      if (!response?.ok) {
        inlineToggle.checked = !inlineToggle.checked;
        showNotice(response?.error || "Could not update companion mode.");
      } else {
        state.companionMode = mode;
        showNotice(
          mode === "inline"
            ? "Vintrack actions enabled inside Vinted."
            : "Inline Vinted actions disabled.",
          "ok",
        );
      }
    });

    void refresh();
    return {
      refresh,
      selectTab,
      destroy() {
        destroyed = true;
        stopLiveFeed();
        extensionApi?.storage?.onChanged?.removeListener(
          handleStorageThemeChange,
        );
        root.remove();
      },
    };
  }

  globalThis.VintrackCompanion = { mount: mountCompanion };
})();
