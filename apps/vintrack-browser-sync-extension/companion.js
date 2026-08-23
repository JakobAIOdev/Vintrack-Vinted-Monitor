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
    for (const [name, label] of [
      ["overview", "Overview"],
      ["feed", "Feed"],
      ["watches", "Watches"],
    ]) {
      const button = element("button", "", label);
      button.type = "button";
      button.dataset.tab = name;
      button.setAttribute(
        "aria-selected",
        name === "overview" ? "true" : "false",
      );
      tabs.appendChild(button);
    }

    const notice = element("div", "vtc-notice");
    notice.hidden = true;
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

    const footer = element("footer", "vtc-footer");
    const modeLabel = element("label", "vtc-mode");
    const inlineToggle = element("input");
    inlineToggle.type = "checkbox";
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
      notice.hidden = !message;
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
          element("strong", "vtc-card-title", "No supported Vinted context"),
          element(
            "p",
            "vtc-muted",
            "Open a Vinted catalog or item tab to use a quick handoff.",
          ),
        );
      }
      parent.appendChild(card);
    }

    function renderOverview() {
      overviewPanel.replaceChildren();
      if (!state?.configured) {
        const empty = emptyState(
          "Connect Vintrack",
          "Open Vintrack Account and link this browser once. The link stays stored until you explicitly clear it.",
        );
        addButton(empty, "Open Vintrack Account", "open", {
          destination: "account",
        });
        overviewPanel.appendChild(empty);
        return;
      }

      const account = state.overview?.account;
      const accountStatus = account?.available
        ? account.linked
          ? account.requiresBrowserReauth
            ? "Browser refresh needed"
            : "Linked"
          : "Not linked"
        : "Status unavailable";
      const statusClass =
        account?.available && account?.linked
          ? "vtc-status vtc-status-ok"
          : "vtc-status";

      renderContext(overviewPanel);

      const links = element("div", "vtc-card vtc-quick-links");
      links.appendChild(element("span", "vtc-eyebrow", "QUICK LINKS"));
      const grid = element("div", "vtc-link-grid");
      for (const [label, destination] of [
        ["Dashboard", "dashboard"],
        ["Monitors", "monitors"],
        ["New monitor", "newMonitor"],
        ["Notifications", "notifications"],
        ["Feed", "feed"],
        ["Watches", "priceWatches"],
        ["Chats", "chats"],
        ["Favorites", "favorites"],
        ["Account", "account"],
      ]) {
        addButton(grid, label, "open", { destination, secondary: true });
      }
      links.appendChild(grid);
      overviewPanel.appendChild(links);

      const metrics = element("div", "vtc-metrics");
      metrics.append(
        metric("Active monitors", state.overview?.monitors?.active ?? 0),
        metric("Price Watches", state.overview?.priceWatches?.total ?? 0),
      );
      overviewPanel.appendChild(metrics);

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
          [accountStatus, account?.domain].filter(Boolean).join(" · "),
        ),
      );
      accountSummary.append(
        accountCopy,
        element("span", statusClass, accountStatus),
      );
      accountCard.appendChild(accountSummary);
      addButton(accountCard, "Sync linked account now", "sync", {
        secondary: true,
      });
      overviewPanel.appendChild(accountCard);
    }

    function renderFeed() {
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
      addButton(feedPanel, "Open full feed", "open", {
        destination: "feed",
        secondary: true,
      });
    }

    async function loadLiveFeed() {
      if (feedBusy || !state?.configured) return;
      feedBusy = true;
      const response = await send({ type: "VINTRACK_COMPANION_FEED" });
      feedBusy = false;
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
      watchesPanel.replaceChildren();
      if (!state?.configured) {
        watchesPanel.appendChild(
          emptyState(
            "Connect Vintrack",
            "Your Price Watches appear after linking.",
          ),
        );
        return;
      }
      if (!watchesLoaded) {
        watchesPanel.appendChild(
          emptyState("Loading…", "Fetching Price Watches."),
        );
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
        addButton(watchesPanel, "Load more", "load-more", { secondary: true });
      }
      addButton(watchesPanel, "Open all Price Watches", "open", {
        destination: "priceWatches",
        secondary: true,
      });
    }

    async function loadWatches(append = false) {
      if (busy) return;
      busy = true;
      const response = await send({
        type: "VINTRACK_COMPANION_PRICE_WATCHES",
        payload: { cursor: append ? nextCursor : "" },
      });
      busy = false;
      watchesLoaded = true;
      if (!response?.ok) {
        showNotice(response?.error || "Price Watches unavailable.");
        renderWatches();
        return;
      }
      watches = append
        ? [...watches, ...(response.items || [])]
        : response.items || [];
      nextCursor = response.nextCursor || null;
      renderWatches();
    }

    function selectTab(name) {
      activeTab = name;
      for (const button of root.querySelectorAll("[data-tab]")) {
        button.setAttribute(
          "aria-selected",
          button.dataset.tab === name ? "true" : "false",
        );
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

    async function refresh() {
      showNotice("");
      root.dataset.loading = "true";
      const response = await send({ type: "VINTRACK_COMPANION_STATE" });
      root.dataset.loading = "false";
      state = response || { ok: false };
      applyTheme(state.theme);
      inlineToggle.checked = state.companionMode !== "popup";
      version.textContent = state.version ? `v${state.version}` : "";
      if (!state.ok && state.error) showNotice(state.error);
      if (state.contextError) showNotice(state.contextError, "warning");
      renderOverview();
      renderFeed();
      renderWatches();
      options.onStateChange?.(state);
      if (activeTab === "feed") startLiveFeed();
      return state;
    }

    async function mutateWatch(id, operation) {
      if (busy) return;
      busy = true;
      const response = await send({
        type: "VINTRACK_COMPANION_WATCH_MUTATION",
        payload: { id, operation },
      });
      busy = false;
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
      await refresh();
    }

    root.addEventListener("click", async (event) => {
      const target = event.target.closest("button");
      if (!target || busy) return;
      if (target.dataset.tab) {
        selectTab(target.dataset.tab);
        return;
      }
      const action = target.dataset.action;
      if (action === "close") {
        options.onClose?.();
      } else if (action === "refresh") {
        watchesLoaded = false;
        watches = [];
        nextCursor = null;
        await refresh();
      } else if (action === "sync") {
        busy = true;
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
        target.textContent = "Sync now";
        if (response?.ok) await refresh();
      } else if (action === "open") {
        await send({
          type: "VINTRACK_COMPANION_OPEN",
          payload: {
            destination: target.dataset.destination,
            id: target.dataset.id,
          },
        });
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
      } else if (action === "load-more") {
        await loadWatches(true);
      }
    });

    inlineToggle.addEventListener("change", async () => {
      const mode = inlineToggle.checked ? "inline" : "popup";
      const response = await send({
        type: "VINTRACK_COMPANION_SET_MODE",
        payload: { mode },
      });
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
