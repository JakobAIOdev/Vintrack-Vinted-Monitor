(function () {
  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function readCookie(name) {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));

    if (!cookie) {
      return "";
    }

    return cookie.slice(name.length + 1).trim();
  }

  function localeFromHost(hostname) {
    if (hostname.includes("vinted.de")) return "de-DE";
    if (hostname.includes("vinted.fr")) return "fr-FR";
    if (hostname.includes("vinted.es")) return "es-ES";
    if (hostname.includes("vinted.it")) return "it-IT";
    if (hostname.includes("vinted.nl")) return "nl-NL";
    if (hostname.includes("vinted.pl")) return "pl-PL";
    if (hostname.includes("vinted.co.uk")) return "en-GB";
    if (hostname.includes("vinted.com")) return "en-US";
    return navigator.language || "de-DE";
  }

  function portalFromHost(hostname) {
    if (hostname.includes("vinted.de")) return "de";
    if (hostname.includes("vinted.fr")) return "fr";
    if (hostname.includes("vinted.es")) return "es";
    if (hostname.includes("vinted.it")) return "it";
    if (hostname.includes("vinted.nl")) return "nl";
    if (hostname.includes("vinted.pl")) return "pl";
    if (hostname.includes("vinted.co.uk")) return "uk";
    if (hostname.includes("vinted.com")) return "com";
    return "de";
  }

  function extractCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta?.content) {
      return meta.content.trim();
    }

    const html = document.documentElement?.innerHTML || "";
    const patterns = [
      /<meta\s+name="csrf-token"\s+content="([^"]+)"/i,
      /<meta\s+content="([^"]+)"\s+name="csrf-token"/i,
      /"csrfToken"\s*:\s*"([^"]+)"/,
      /"csrf_token"\s*:\s*"([^"]+)"/,
      /CSRF_TOKEN\\?":\s*\\?"([^"\\]+)/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    return "";
  }

  function extractIncogniaRequestToken() {
    const candidates = [];

    const pushValue = (value) => {
      if (typeof value === "string" && value.trim().length > 20) {
        candidates.push(value.trim());
      }
    };

    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key && key.toLowerCase().includes("incognia")) {
          pushValue(window.localStorage.getItem(key));
        }
      }
    } catch {}

    try {
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (key && key.toLowerCase().includes("incognia")) {
          pushValue(window.sessionStorage.getItem(key));
        }
      }
    } catch {}

    const scripts = Array.from(document.scripts).map((script) => script.textContent || "");
    const match = scripts
      .join("\n")
      .match(/incognia[^"'`]*request[^"'`]*token["'` ]*[:=]["'`]([^"'`]+)/i);
    if (match?.[1]) {
      pushValue(match[1]);
    }

    return candidates[0] || "";
  }

  function truncate(value, maxLength) {
    if (typeof value !== "string") {
      return "";
    }

    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  }

  function extractCaptchaUrl(body) {
    const normalized = String(body || "").replace(/\\\//g, "/");
    const match = normalized.match(/https:\/\/geo\.captcha-delivery\.com\/captcha\/[^"'\s<]+/i);
    return match?.[0] || "";
  }

  function isPaymentAlreadyProcessing(body) {
    const lower = String(body || "").toLowerCase();
    return (
      lower.includes("zahlung im gange") ||
      lower.includes("payment in progress") ||
      (lower.includes("bezahlungsvorgang") &&
        (lower.includes("abgeschlossen") || lower.includes("bearbeitet")))
    );
  }

  async function refreshBrowserSession() {
    const csrfToken = extractCsrfToken();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${window.location.origin}/web/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/plain, */*",
          ...(csrfToken ? { "X-Csrf-Token": csrfToken } : {}),
        },
      });
      return {
        ok: response.ok,
        status: response.status,
        retryAfter: response.headers.get("Retry-After") || "",
        domain: window.location.hostname,
        error: response.ok ? "" : "Vinted could not refresh the browser session.",
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function waitForDocumentReady(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      // CSRF context is in the parsed document. Images, analytics and the load
      // event are not prerequisites for the request-only checkout flow.
      if (document.readyState !== "loading") {
        resolve();
        return;
      }

      const timeout = window.setTimeout(() => {
        document.removeEventListener("DOMContentLoaded", handleLoad);
        reject(new Error("Vinted page did not finish loading in time"));
      }, timeoutMs);

      function handleLoad() {
        window.clearTimeout(timeout);
        document.removeEventListener("DOMContentLoaded", handleLoad);
        resolve();
      }

      document.addEventListener("DOMContentLoaded", handleLoad, { once: true });
    });
  }

  function findStringByPaths(node, paths) {
    for (const path of paths) {
      let current = node;
      let valid = true;
      for (const key of path) {
        if (!isObject(current) || !(key in current)) {
          valid = false;
          break;
        }
        current = current[key];
      }
      if (valid && typeof current === "string" && current.trim()) {
        return current.trim();
      }
    }

    return "";
  }

  function findNumberByPaths(node, paths) {
    for (const path of paths) {
      let current = node;
      let valid = true;
      for (const key of path) {
        if (!isObject(current) || !(key in current)) {
          valid = false;
          break;
        }
        current = current[key];
      }
      if (valid) {
        const parsed = Number(current);
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }
    }

    return 0;
  }

  function findUrlContaining(node, fragment) {
    if (typeof node === "string" && node.includes(fragment)) {
      return node;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = findUrlContaining(entry, fragment);
        if (found) {
          return found;
        }
      }
      return "";
    }

    if (isObject(node)) {
      for (const value of Object.values(node)) {
        const found = findUrlContaining(value, fragment);
        if (found) {
          return found;
        }
      }
    }

    return "";
  }

  function findStringByKey(node, targetKey) {
    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = findStringByKey(entry, targetKey);
        if (found) {
          return found;
        }
      }
      return "";
    }

    if (!isObject(node)) {
      return "";
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === targetKey && typeof value === "string" && value.trim()) {
        return value.trim();
      }

      const nested = findStringByKey(value, targetKey);
      if (nested) {
        return nested;
      }
    }

    return "";
  }

  function findNumberByKeys(node, keys) {
    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = findNumberByKeys(entry, keys);
        if (found) {
          return found;
        }
      }
      return 0;
    }

    if (!isObject(node)) {
      return 0;
    }

    for (const [key, value] of Object.entries(node)) {
      if (keys.includes(key)) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }

      const nested = findNumberByKeys(value, keys);
      if (nested) {
        return nested;
      }
    }

    return 0;
  }

  function buildCheckoutUrl(purchaseId, transactionId) {
    return `${window.location.origin}/checkout?purchase_id=${encodeURIComponent(purchaseId)}&order_id=${transactionId}&order_type=transaction`;
  }

  async function vintedRequest(step, input) {
    const headers = new Headers({
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": `${localeFromHost(window.location.hostname)},en-US;q=0.8,en;q=0.7`,
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Locale": localeFromHost(window.location.hostname),
      "X-Platform": "web",
      "X-Portal": portalFromHost(window.location.hostname),
      "X-Debug-Info": "v4",
      "X-Local-Time": String(Date.now()),
    });

    const csrfToken = extractCsrfToken();
    if (csrfToken) {
      headers.set("X-Csrf-Token", csrfToken);
    }

    const anonId = readCookie("anon_id");
    if (anonId) {
      headers.set("X-Anon-Id", anonId);
    }

    if (input.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    if (input.incogniaRequestToken) {
      headers.set("X-Incognia-Request-Token", input.incogniaRequestToken);
    }

    const response = await fetch(input.url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      credentials: "include",
      redirect: input.redirect || "follow",
      referrer: input.referrer,
      referrerPolicy: "strict-origin-when-cross-origin",
    });

    const text = await response.text();
    let data = null;

    try {
      data = JSON.parse(text);
    } catch {}

    if (!response.ok) {
      const lower = text.toLowerCase();
      if (lower.includes("captcha-delivery.com") || lower.includes("datadome")) {
        return {
          ok: false,
          code: "datadome_challenge",
          step,
          error: `datadome challenge at ${step} (HTTP ${response.status})`,
          statusCode: response.status,
          captchaUrl:
            findUrlContaining(data, "captcha-delivery.com") ||
            findStringByKey(data, "captcha_url") ||
            extractCaptchaUrl(text),
          raw: truncate(text, 2000),
        };
      }

      if (isPaymentAlreadyProcessing(text)) {
        return {
          ok: false,
          code: "payment_already_processing",
          step,
          error: "A payment is already in progress for this transaction",
          statusCode: response.status,
          raw: truncate(text, 2000),
        };
      }

      return {
        ok: false,
        code: "vinted_request_failed",
        step,
        error:
          (data && typeof data.error === "string" && data.error) ||
          (data && typeof data.message === "string" && data.message) ||
          `${step} failed (HTTP ${response.status})`,
        statusCode: response.status,
        raw: truncate(text, 2000),
      };
    }

    return { ok: true, data, text };
  }

  async function getBrowserAccount() {
    const result = await vintedRequest("current account", {
      method: "GET",
      url: `${window.location.origin}/api/v2/users/current`,
      referrer: window.location.href,
    });
    if (!result.ok) {
      return result;
    }

    const accountId = findNumberByPaths(result.data, [
      ["user", "id"],
      ["id"],
    ]);
    const accountName = findStringByPaths(result.data, [
      ["user", "login"],
      ["login"],
    ]);
    if (!accountId) {
      return {
        ok: false,
        code: "browser_account_missing",
        error: "Could not identify the account open in this Vinted tab",
      };
    }

    return {
      ok: true,
      accountId,
      accountName,
      domain: window.location.hostname,
    };
  }

  const checkoutPayments = ["wallet", "paypal", "vinted", "card", "google_pay", "klarna", "tink", "bancontact", "ideal", "blik", "przelewy24"];

  function checkoutProvider(method) {
    const value = String(method?.payment_method || "").toLowerCase();
    if (value === "credit_card") return "card";
    if (checkoutPayments.includes(value) && !["wallet", "vinted"].includes(value)) return value;
    const tokens = `_${String(method?.code || "").toUpperCase()}_`;
    for (const provider of checkoutPayments) {
      if (!["wallet", "vinted", "card"].includes(provider) && tokens.includes(`_${provider.toUpperCase()}_`)) return provider;
    }
    if (tokens.includes("_WERO_")) return "ideal";
    if (tokens.includes("_CARD_")) return "card";
    return "";
  }

  function selectedCheckoutPayment(data) {
    const selected = data?.checkout?.components?.payment_method?.selected_payment_method;
    const provider = checkoutProvider(selected?.pay_in_method);
    if (provider === "card" && !selectedCardId(selected)) return "";
    return provider;
  }

  function validCardId(value) {
    if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
    return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) && value !== "0" ? value : null;
  }

  function selectedCardId(selected) {
    if (selected?.expired === true || selected?.card?.expired === true || selected?.credit_card?.expired === true) return null;
    return validCardId(selected?.card_id || selected?.card?.id || selected?.credit_card?.external_code);
  }

  function cardPaymentOutcome(data) {
    if (data?.errors != null || data?.error != null) return {};
    if (data?.action != null && !data.action.type) return {};
    if (data?.action?.type) {
      if (["sca_required", "sca_challenge", "sca_blocked", "payrails_cvv_resubmission", "native_adyen_card_3ds", "native_adyen_payment_3ds", "redirect"].includes(data.action.type))
        return { status: "card_authentication_required", autoCheckoutReason: "Continue in Vinted to review or complete card authentication. A payment was already started; do not pay again." };
      return {};
    }
    switch (data?.payment?.status) {
      case "success": return { status: "card_payment_confirmed", autoCheckoutReason: "Vinted reports that the card payment succeeded. Check the order in Vinted; do not pay again." };
      case "pending": case "preparing": return { status: "card_payment_pending", autoCheckoutReason: "The card payment is processing. Check its status in Vinted; do not pay again." };
      case "failure": return { status: "card_payment_failed", autoCheckoutReason: "Vinted reports a failed card payment. Review it in Vinted; no automatic retry will run." };
      default: return {};
    }
  }

  function checkoutPaymentChoice(data, preference) {
    const payment = data?.checkout?.components?.payment_method;
    const choices = (Array.isArray(payment?.pay_in_methods) ? payment.pay_in_methods : [])
      .filter((method) => checkoutProvider(method) === preference && method.read_only !== true && method.enabled !== false)
      .map((method) => {
        const native = method.payment_method || (method.code === "MANGOPAY_PAYPAL" ? "paypal" : "");
        if (typeof native !== "string" || !/^[a-zA-Z0-9_]{1,64}$/.test(native)) return null;
        let cardId = null;
        if (preference === "card") {
          const selected = payment.selected_payment_method;
          cardId = selectedCardId(selected);
          if (!cardId && checkoutProvider(selected?.pay_in_method) !== "card" && Array.isArray(payment.cards) && payment.cards.length === 1 && payment.cards[0]?.expired !== true) {
            cardId = validCardId(payment.cards[0]?.id);
          }
          if (!cardId) return null;
          if (Array.isArray(payment.cards) && payment.cards.some(card => String(card?.id) === String(cardId) && card?.expired === true)) return null;
        }
        return { card_id: cardId, payment_method: native };
      }).filter(Boolean);
    if (choices.length === 1) return choices[0];
    // Multiple variants must not silently choose a different saved method.
    const selectedNative = payment?.selected_payment_method?.pay_in_method?.payment_method;
    return choices.find((choice) => choice.payment_method === selectedNative) || null;
  }

  function validAutoCheckout(preferences) {
    const setting = preferences.autoCheckout;
    if (setting === undefined) return true;
    return isObject(setting) && Object.keys(setting).length === 3 &&
      setting.warningVersion === (preferences.payment === "card" ? 2 : 1) && setting.currency === "EUR" &&
      Number.isSafeInteger(setting.maxTotalMinor) && setting.maxTotalMinor > 0 && setting.maxTotalMinor <= 1_000_000 &&
      (preferences.payment === "card" || preferences.payment === "paypal" && ["www.vinted.de", "www.vinted.at", "www.vinted.be"].includes(window.location.hostname));
  }

  function checkoutMoneyMinor(price) {
    if (price?.currency_code !== "EUR" || !["string", "number"].includes(typeof price.amount)) return null;
    const amount = String(price.amount);
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(amount)) return null;
    const [whole, fraction = ""] = amount.split(".");
    return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  }

  function autoCheckoutTotal(data) {
    const components = data?.checkout?.components;
    const summary = components?.order_summary_v2;
    if (!summary || summary.currency_conversion != null || !Array.isArray(summary.deductions)) return null;
    for (const deduction of summary.deductions) {
      if (deduction?.type !== "order-summary-wallet-deduction" || checkoutMoneyMinor(deduction.price) !== 0) return null;
    }
    const total = checkoutMoneyMinor(components?.pay_button_v2?.total?.price);
    return total > 0 ? total : null;
  }

  function validPayPalPaymentUrl(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" && ["www.paypal.com", "paypal.com"].includes(url.host) &&
        !url.username && !url.password && !url.hash && ["/checkoutnow", "/webscr", "/cgi-bin/webscr"].includes(url.pathname);
    } catch { return false; }
  }

  async function runBrowserBuy(payload) {
    const startedAt = Date.now();
    await waitForDocumentReady();
    const timings = { contextMs: Date.now() - startedAt };
    async function checkoutRequest(key, step, input) {
      const requestAt = Date.now();
      try { return await vintedRequest(step, input); }
      finally { timings[key] = (timings[key] || 0) + Date.now() - requestAt; }
    }

    const itemId = Number(payload?.itemId || 0);
    const sellerId = Number(payload?.sellerId || 0);
    const expectedAccountId = Number(payload?.expectedAccountId || 0);
    const preferences = payload?.preferences || { shipping: "vinted", payment: "vinted" };
    if (!preferences || typeof preferences !== "object" ||
        Object.keys(preferences).some((key) => !["shipping", "payment", "autoCheckout"].includes(key)) ||
        !["home", "vinted"].includes(preferences.shipping) ||
        !checkoutPayments.includes(preferences.payment) || !validAutoCheckout(preferences)) {
      return { ok: false, code: "invalid_checkout_preferences", error: "Invalid checkout preferences" };
    }
    const phoneNumber = typeof payload?.phoneNumber === "string" ? payload.phoneNumber.trim() : "";
    const itemUrl = typeof payload?.itemUrl === "string" && payload.itemUrl.trim()
      ? payload.itemUrl.trim()
      : `${window.location.origin}/items/${itemId}`;
    const incogniaRequestToken =
      (typeof payload?.incogniaRequestToken === "string" && payload.incogniaRequestToken.trim()) ||
      extractIncogniaRequestToken();

    if (!Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isSafeInteger(sellerId) || sellerId <= 0 || !Number.isSafeInteger(expectedAccountId) || expectedAccountId <= 0) {
      return {
        ok: false,
        code: "invalid_buy_payload",
        error: "Missing item or seller information",
      };
    }

    const accountAt = Date.now();
    const account = await getBrowserAccount();
    timings.accountMs = Date.now() - accountAt;
    if (!account.ok) return account;
    if (account.accountId !== expectedAccountId || sellerId === expectedAccountId) {
      return { ok: false, code: "checkout_account_mismatch", error: "Open Vinted with the account linked to Vintrack before starting checkout." };
    }

    const conversationResult = await checkoutRequest("transactionMs", "buy conversation", {
      method: "POST",
      url: `${window.location.origin}/api/v2/conversations`,
      referrer: itemUrl,
      body: {
        initiator: "buy",
        item_id: String(itemId),
        opposite_user_id: String(sellerId),
      },
    });
    if (!conversationResult.ok) {
      return conversationResult;
    }

    const transactionId =
      findNumberByPaths(conversationResult.data, [
        ["conversation", "transaction", "id"],
        ["transaction", "id"],
      ]) || findNumberByKeys(conversationResult.data, ["id"]);

    if (!transactionId) {
      return {
        ok: false,
        code: "missing_transaction_id",
        error: "Could not extract transaction id from Vinted buy conversation",
      };
    }

    const buildResult = await checkoutRequest("buildMs", "checkout build", {
      method: "POST",
      url: `${window.location.origin}/api/v2/purchases/checkout/build`,
      referrer: itemUrl,
      incogniaRequestToken,
      body: {
        purchase_items: [{ id: transactionId, type: "transaction" }],
      },
    });
    if (!buildResult.ok) {
      return {
        ...buildResult,
        itemId,
        sellerId,
        transactionId,
      };
    }

    const purchaseId =
      findStringByPaths(buildResult.data, [
        ["purchase", "id"],
        ["purchase", "uid"],
        ["checkout", "purchase_id"],
        ["checkout", "id"],
        ["purchase_id"],
      ]) || findStringByKey(buildResult.data, "purchase_id");

    if (!purchaseId) {
      return {
        ok: false,
        code: "missing_purchase_id",
        error: "Checkout build did not return a purchase id",
      };
    }

    let checksum =
      findStringByPaths(buildResult.data, [
        ["checksum"],
        ["checkout", "checksum"],
        ["payment", "checksum"],
      ]) || findStringByKey(buildResult.data, "checksum");
    let checkoutUrl =
      findStringByPaths(buildResult.data, [
        ["checkout_url"],
        ["checkout", "url"],
      ]) || findUrlContaining(buildResult.data, "/checkout");
    let shippingOrderId =
      findNumberByPaths(buildResult.data, [
        ["shipping_order_id"],
        ["shippingOrderId"],
        ["shipping_order", "id"],
        ["shippingOrder", "id"],
        ["checkout", "shipping_order_id"],
        ["checkout", "shipping_order", "id"],
      ]) || findNumberByKeys(buildResult.data, ["shipping_order_id", "shippingOrderId"]);

    const checkoutReferrer = buildCheckoutUrl(purchaseId, transactionId);
    function components(payment = null) {
      return {
        additional_service: {},
        payment_method: payment || {},
        shipping_address: {},
        shipping_pickup_options: preferences.shipping === "home" ? { pickup_type: 1 } : {},
        shipping_pickup_details: {},
      };
    }
    let paymentChoice = checkoutPaymentChoice(buildResult.data, preferences.payment);
    let updateResult = await checkoutRequest("updateMs", "checkout update", {
      method: "PUT",
      url: `${window.location.origin}/api/v2/purchases/${encodeURIComponent(purchaseId)}/checkout`,
      referrer: checkoutReferrer,
      body: {
        components: components(paymentChoice),
      },
    });
    if (!updateResult.ok) {
      return updateResult;
    }
    const updatedChoice = checkoutPaymentChoice(updateResult.data, preferences.payment);
    if (!paymentChoice && updatedChoice && selectedCheckoutPayment(updateResult.data) !== preferences.payment) {
      paymentChoice = updatedChoice;
      updateResult = await checkoutRequest("updateMs", "checkout preferences", {
        method: "PUT",
        url: `${window.location.origin}/api/v2/purchases/${encodeURIComponent(purchaseId)}/checkout`,
        referrer: checkoutReferrer,
        body: { components: components(updatedChoice) },
      });
      if (!updateResult.ok) return updateResult;
    }

    checksum =
      findStringByPaths(updateResult.data, [
        ["checksum"],
        ["checkout", "checksum"],
        ["payment", "checksum"],
      ]) ||
      findStringByKey(updateResult.data, "checksum") ||
      checksum;
    checkoutUrl =
      findStringByPaths(updateResult.data, [
        ["checkout_url"],
        ["checkout", "url"],
      ]) ||
      findUrlContaining(updateResult.data, "/checkout") ||
      checkoutUrl;
    shippingOrderId =
      findNumberByPaths(updateResult.data, [
        ["shipping_order_id"],
        ["shippingOrderId"],
        ["shipping_order", "id"],
        ["shippingOrder", "id"],
        ["checkout", "shipping_order_id"],
        ["checkout", "shipping_order", "id"],
      ]) ||
      findNumberByKeys(updateResult.data, ["shipping_order_id", "shippingOrderId"]) ||
      shippingOrderId;

    if (phoneNumber && shippingOrderId) {
      const shippingContactResult = await checkoutRequest("contactMs", "shipping contact", {
        method: "POST",
        url: `${window.location.origin}/api/v2/shipping_orders/${shippingOrderId}/shipping_contact`,
        referrer: checkoutReferrer,
        body: {
          save_for_later: true,
          receiver_phone_number: phoneNumber,
        },
      });
      if (!shippingContactResult.ok) {
        return shippingContactResult;
      }

      checksum =
        findStringByPaths(shippingContactResult.data, [
          ["checksum"],
          ["checkout", "checksum"],
          ["payment", "checksum"],
        ]) ||
        findStringByKey(shippingContactResult.data, "checksum") ||
        checksum;
      checkoutUrl =
        findStringByPaths(shippingContactResult.data, [
          ["checkout_url"],
          ["checkout", "url"],
        ]) ||
        findUrlContaining(shippingContactResult.data, "/checkout") ||
        checkoutUrl;
    }

    const selected = updateResult.data?.checkout?.components;
    const ready = Boolean(
      selected?.payment_method?.selected_payment_method &&
      selected?.shipping_address?.address &&
      selected?.shipping_pickup_options?.selected_pickup_option === 1 &&
      selected?.shipping_pickup_details?.pickup_details?.selected_rate_uuid &&
      selected?.pay_button_v2?.payments_available === true &&
      preferences.payment !== "wallet" &&
      (preferences.payment === "vinted" || selectedCheckoutPayment(updateResult.data) === preferences.payment)
    );
    const prepared = {
      ok: true,
      status: ready ? "checkout_prepared" : "checkout_review_required",
      itemId,
      sellerId,
      transactionId,
      purchaseId,
      checkoutUrl: checkoutUrl || checkoutReferrer,
      shippingOrderId,
      timings,
    };
    if (!preferences.autoCheckout) return prepared;
    prepared.status = "checkout_review_required";
    prepared.autoCheckoutReason = "Review the checkout: payment method, delivery or price could not be verified. No automatic payment was started.";
    const total = autoCheckoutTotal(updateResult.data);
    const currentChecksum = findStringByPaths(updateResult.data, [["checksum"], ["checkout", "checksum"]]);
    // Contact updates may change the quote. Do not pay against an earlier state.
    if (!ready || phoneNumber || total === null || total > preferences.autoCheckout.maxTotalMinor ||
        !currentChecksum || !checkoutPaymentChoice(updateResult.data, preferences.payment) ||
        (preferences.payment === "card" && (updateResult.data?.checkout?.adyen_protect_signals_enabled === true || updateResult.data?.adyen_protect_signals_enabled === true ||
          paymentChoice && String(paymentChoice.card_id) !== String(selectedCardId(selected?.payment_method?.selected_payment_method))))) return prepared;
    prepared.status = "payment_outcome_unknown";
    prepared.autoCheckoutReason = "A payment request was sent but its outcome could not be verified. Check Vinted; do not start it again.";
    try {
      // Background persisted intent before the first mutation; no retries here.
      const payment = await checkoutRequest("paymentMs", "Checkout payment start", {
        method: "POST",
        url: `${window.location.origin}/api/v2/purchases/${encodeURIComponent(purchaseId)}/checkout/payment`,
        referrer: checkoutReferrer,
        redirect: "error",
        incogniaRequestToken,
        body: { checksum: currentChecksum, payment_options: { browser_info: {
          language: navigator.language || "en-US", color_depth: window.screen?.colorDepth || 24,
          java_enabled: false, screen_height: window.screen?.height || 1080, screen_width: window.screen?.width || 1920,
          timezone_offset: new Date().getTimezoneOffset(),
        } } },
      });
      const redirect = payment.data?.action?.parameters?.url;
      if (preferences.payment === "paypal" && payment.ok && payment.data?.action?.type === "redirect" && validPayPalPaymentUrl(redirect)) {
        prepared.status = "paypal_redirect_ready";
        prepared.autoCheckoutReason = "Continue in PayPal to complete the payment.";
        prepared.paymentUrl = redirect;
      } else if (preferences.payment === "card" && payment.ok) {
        Object.assign(prepared, cardPaymentOutcome(payment.data));
      }
    } catch { /* An uncertain payment must never be replayed automatically. */ }
    if (preferences.payment === "card") {
      // Native Vinted reads the existing payment with GET and renders its own
      // 3-D Secure/CVV handler. Never resubmit payment or copy bank tokens.
      const resume = new URL(prepared.checkoutUrl);
      if (resume.origin === window.location.origin && resume.pathname === "/checkout") {
        resume.searchParams.set("after_payment_redirect", "true");
        prepared.checkoutUrl = resume.href;
      }
    }
    return prepared;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data?.type) {
      return;
    }

    if (event.data.type === "VINTRACK_PAGE_ACCOUNT_REQUEST") {
      const requestId = event.data.payload?.requestId || crypto.randomUUID();
      getBrowserAccount()
        .then((result) => {
          window.postMessage(
            {
              type: "VINTRACK_PAGE_ACCOUNT_RESPONSE",
              payload: { ...result, requestId },
            },
            window.location.origin
          );
        })
        .catch((error) => {
          window.postMessage(
            {
              type: "VINTRACK_PAGE_ACCOUNT_RESPONSE",
              payload: {
                ok: false,
                requestId,
                code: "browser_account_exception",
                error: error instanceof Error ? error.message : "Unknown browser account lookup failure",
              },
            },
            window.location.origin
          );
        });
      return;
    }

    if (event.data.type === "VINTRACK_PAGE_SESSION_REFRESH_REQUEST") {
      const requestId = event.data.payload?.requestId || crypto.randomUUID();
      refreshBrowserSession()
        .then((result) => {
          window.postMessage(
            {
              type: "VINTRACK_PAGE_SESSION_REFRESH_RESPONSE",
              payload: { ...result, requestId },
            },
            window.location.origin
          );
        })
        .catch((error) => {
          window.postMessage(
            {
              type: "VINTRACK_PAGE_SESSION_REFRESH_RESPONSE",
              payload: {
                ok: false,
                requestId,
                code: "page_session_refresh_exception",
                error: error instanceof Error ? error.message : "Unknown browser session refresh failure",
              },
            },
            window.location.origin
          );
        });
      return;
    }

    if (event.data.type !== "VINTRACK_PAGE_BUY_REQUEST" || !event.data.payload?.requestId) {
      return;
    }

    const { requestId } = event.data.payload;
    runBrowserBuy(event.data.payload)
      .then((result) => {
        window.postMessage(
          {
            type: "VINTRACK_PAGE_BUY_RESPONSE",
            payload: { ...result, requestId },
          },
          window.location.origin
        );
      })
      .catch((error) => {
        window.postMessage(
          {
            type: "VINTRACK_PAGE_BUY_RESPONSE",
            payload: {
              ok: false,
              requestId,
              code: "page_buy_exception",
              error: error instanceof Error ? error.message : "Unknown browser buy failure",
            },
          },
          window.location.origin
        );
      });
  });

  window.postMessage({ type: "VINTRACK_PAGE_BRIDGE_READY" }, window.location.origin);
})();
