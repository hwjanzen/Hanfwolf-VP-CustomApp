import type { LoaderFunctionArgs } from "react-router";

const scriptBody = String.raw`(function () {
  function normalizeId(raw, prefix) {
    if (!raw) return null;
    var value = String(raw).trim();
    if (!value) return null;
    if (value.indexOf(prefix) === 0) return value;
    if (/^\d+$/.test(value)) return prefix + value;
    return null;
  }

  function findCurrentScript() {
    var scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  }

  var script = findCurrentScript();
  var proxyPath = script.dataset.proxyPath || "/apps/hanfwolf-pricing";
  var configuredCompanyId = script.dataset.companyId || "";
  var configuredCustomerId = script.dataset.customerId || "";
  var configuredHeaderId = script.dataset.headerId || "";
  var defaultQuantity = Number(script.dataset.quantity || "1");
  var showDebugBadge = script.dataset.debugBadge !== "false";
  var currencyCode = script.dataset.currency || "EUR";

  function getStoreRoot() {
    var root =
      window.Shopify &&
      window.Shopify.routes &&
      typeof window.Shopify.routes.root === "string"
        ? window.Shopify.routes.root
        : "/";

    return root.endsWith("/") ? root : root + "/";
  }

  function buildProxyUrl(params) {
    var url = new URL(proxyPath, window.location.origin);
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  function buildProxyActionUrl(action) {
    var url = new URL(proxyPath, window.location.origin);
    url.pathname = url.pathname.replace(/\/$/, "") + "/" + encodeURIComponent(action);
    return url.toString();
  }

  function formatMoney(numberValue) {
    if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) {
      return "n/a";
    }
    return numberValue.toFixed(2);
  }

  function formatStoreMoney(numberValue) {
    if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) {
      return "n/a";
    }

    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
      }).format(numberValue);
    } catch (e) {
      return formatMoney(numberValue);
    }
  }

  async function fetchVariantJson(handle) {
    var root = getStoreRoot();
    var response = await fetch(
      root + "products/" + encodeURIComponent(handle) + ".js",
      {
      credentials: "same-origin",
      },
    );
    if (!response.ok) throw new Error("Failed to load product json");
    return response.json();
  }

  async function fetchPrice(variantId, productId, quantity) {
    var companyId = normalizeId(configuredCompanyId, "gid://shopify/Company/");
    var customerId = normalizeId(
      configuredCustomerId,
      "gid://shopify/Customer/",
    );
    var headerId = normalizeId(configuredHeaderId, "gid://shopify/Metaobject/");
    var fullVariantId = normalizeId(
      variantId,
      "gid://shopify/ProductVariant/",
    );
    var fullProductId = normalizeId(productId, "gid://shopify/Product/");

    if (!fullVariantId && !fullProductId) return null;

    var endpoint = buildProxyUrl({
      companyId: companyId,
      customer_id: customerId,
      headerId: headerId,
      productId: fullProductId,
      variantId: fullVariantId,
      quantity: quantity,
    });

    var response = await fetch(endpoint, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      try {
        return await response.json();
      } catch (e) {
        return {
          ok: false,
          error: "HTTP " + response.status,
        };
      }
    }

    try {
      return await response.json();
    } catch (e) {
      return {
        ok: false,
        error: "Invalid JSON response from pricing endpoint.",
      };
    }
  }

  async function requestJson(url, options) {
    var response = await fetch(url, options);
    var payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error("Ungueltige Antwort vom Hanfwolf-Preisservice.");
    }

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || "Der Hanfwolf-Preisservice hat die Anfrage abgelehnt.");
    }

    return payload;
  }

  async function addRopeCutToCart(item) {
    var cartVariant = await requestJson(buildProxyActionUrl("cart-variant"), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ item: item }),
    });

    var cartResponse = await fetch(getStoreRoot() + "cart/add.js", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: cartVariant.cartVariantNumericId,
        quantity: cartVariant.quantity,
        properties: cartVariant.properties,
      }),
    });
    if (!cartResponse.ok) {
      throw new Error("Die Zuschnitt-Variante konnte nicht in den Warenkorb gelegt werden.");
    }

    return cartResponse.json();
  }

  async function finalizeCart() {
    var cart = await requestJson(getStoreRoot() + "cart.js", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    var draftOrder = await requestJson(
      buildProxyActionUrl("cart-draft-order"),
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: (cart.items || []).map(function (item) {
            return {
              variantId: "gid://shopify/ProductVariant/" + item.variant_id,
              quantity: item.quantity,
              properties: item.properties || {},
            };
          }),
        }),
      },
    );

    window.location.assign(draftOrder.checkoutUrl);
  }

  var isCheckoutInProgress = false;

  function isCartCheckoutSubmit(form, submitter) {
    if (!form || !submitter || !form.action) return false;

    var formUrl = new URL(form.action, window.location.origin);
    var isCartForm = /\/cart\/?$/.test(formUrl.pathname);
    var isCheckoutButton =
      submitter.name === "checkout" ||
      submitter.getAttribute("data-hanfwolf-cart-checkout") === "true";

    return isCartForm && isCheckoutButton;
  }

  async function startCartCheckout(control) {
    if (isCheckoutInProgress) return;

    isCheckoutInProgress = true;
    if (control) {
      control.setAttribute("aria-busy", "true");
      if ("disabled" in control) control.disabled = true;
    }

    try {
      await finalizeCart();
    } catch (error) {
      console.error("Failed to finalize Hanfwolf cart", error);
      isCheckoutInProgress = false;
      if (control) {
        control.removeAttribute("aria-busy");
        if ("disabled" in control) control.disabled = false;
      }
      window.alert(
        error && error.message
          ? error.message
          : "Der Warenkorb konnte nicht zur Kasse weitergeleitet werden.",
      );
    }
  }

  function bindCartCheckout() {
    document.addEventListener(
      "submit",
      function (event) {
        if (!isCartCheckoutSubmit(event.target, event.submitter)) return;

        event.preventDefault();
        startCartCheckout(event.submitter);
      },
      true,
    );

    document.addEventListener(
      "click",
      function (event) {
        var link = event.target && event.target.closest && event.target.closest("a[href]");
        if (!link) return;

        var linkUrl = new URL(link.href, window.location.origin);
        if (!/\/checkout\/?$/.test(linkUrl.pathname)) return;

        event.preventDefault();
        startCartCheckout(link);
      },
      true,
    );
  }

  function getBadgeKey(target, contextKey) {
    if (!target) return "page";

    if (contextKey) {
      return contextKey;
    }

    if (!target.dataset.hanfwolfBadgeKey) {
      target.dataset.hanfwolfBadgeKey =
        "badge-" + Math.random().toString(36).slice(2);
    }

    return target.dataset.hanfwolfBadgeKey;
  }

  function renderBadge(target, payload, labelPrefix, contextKey) {
    if (!target || !payload) return;

    var badgeKey = getBadgeKey(target, contextKey);
    var badgeSelector =
      "[data-hanfwolf-custom-price-badge='" + badgeKey + "']";
    var badge = target.querySelector(badgeSelector);
    if (!badge) {
      badge = document.createElement("div");
      badge.setAttribute("data-hanfwolf-custom-price-badge", badgeKey);
      badge.style.marginTop = "6px";
      badge.style.fontSize = "12px";
      badge.style.lineHeight = "1.4";
      badge.style.padding = "8px";
      badge.style.border = "1px solid #dcdcdc";
      badge.style.borderRadius = "8px";
      badge.style.background = "#f7f7f7";
      target.appendChild(badge);
    }

    var sourceLine = showDebugBadge
      ? "<br/>" + "Source: " + payload.source
      : "";

    badge.innerHTML =
      "<strong>" +
      labelPrefix +
      "</strong><br/>" +
      "Unit: " +
      formatMoney(payload.unitPrice) +
      "<br/>" +
      "Qty: " +
      payload.quantity +
      "<br/>" +
      "Total: " +
      formatMoney(payload.addToCartTotal) +
      sourceLine;
  }

  function removeProductBadge(target) {
    var root = target || document;
    var badge = root.querySelector("[data-hanfwolf-custom-price-badge]");
    if (badge) {
      badge.remove();
    }
  }

  function renderMissingPriceMessage(target, payload, contextKey) {
    if (!target) return;

    if (!showDebugBadge) {
      removeProductBadge(target);
      return;
    }

    var message =
      (payload && (payload.error || payload.reason || payload.message)) ||
      "No custom price payload returned.";
    var debugInfo = payload && payload.debug ? payload.debug : null;

    renderBadge(
      target,
      {
        unitPrice: Number.NaN,
        quantity: defaultQuantity || 1,
        addToCartTotal: Number.NaN,
        source: "diagnostic",
      },
      "Custom Add to Cart Price (diagnostic)",
      contextKey,
    );

    var badge = target.querySelector(
      "[data-hanfwolf-custom-price-badge='" + (contextKey || "product") + "']",
    );
    if (badge) {
      var debugBlock = "";
      if (debugInfo) {
        debugBlock =
          "<br/><details style='margin-top:6px;'><summary>Debug context</summary><pre style='white-space:pre-wrap;word-break:break-word;margin:6px 0 0;'>" +
          JSON.stringify(debugInfo, null, 2) +
          "</pre></details>";
      }

      badge.innerHTML =
        "<strong>Custom Add to Cart Price (diagnostic)</strong><br/>" +
        "No price resolved.<br/>" +
        "Reason: " +
        String(message) +
        debugBlock;
    }
  }

  function getSelectedVariantIdFromPage() {
    var queryVariant = new URLSearchParams(window.location.search).get("variant");
    if (queryVariant) return queryVariant;

    var addToCartForm = document.querySelector("form[action*='/cart/add']");
    if (addToCartForm) {
      var input = addToCartForm.querySelector("[name='id']");
      if (input && input.value) return input.value;
    }

    var selectedRadio = document.querySelector("input[name='id']:checked");
    if (selectedRadio && selectedRadio.value) return selectedRadio.value;

    return null;
  }

  function parsePositiveNumber(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function getSelectedQuantityFromPage() {
    var addToCartForm = document.querySelector("form[action*='/cart/add']");
    if (addToCartForm) {
      var quantityInput = addToCartForm.querySelector("[name='quantity']");
      if (quantityInput && quantityInput.value) {
        var formQuantity = parsePositiveNumber(quantityInput.value);
        if (formQuantity) return formQuantity;
      }
    }

    var globalQuantityInput = document.querySelector("[name='quantity']");
    if (globalQuantityInput && globalQuantityInput.value) {
      var globalQuantity = parsePositiveNumber(globalQuantityInput.value);
      if (globalQuantity) return globalQuantity;
    }

    return defaultQuantity || 1;
  }

  function getProductHandleFromPath(pathname) {
    var match = pathname.match(/\/products\/([^\/?#]+)/i);
    return match && match[1] ? match[1] : null;
  }

  function getProductPageTarget() {
    var productInfoSection =
      document.querySelector("[id^='ProductInfo-template--'][id$='__main']") ||
      document.querySelector("[id^='ProductInfo-'][id$='__main']");

    if (productInfoSection) {
      var priceEl = productInfoSection.querySelector(
        "[id^='price-template--'][id$='__main'], [id^='price-'][id$='__main']",
      );

      if (priceEl && priceEl.parentElement) {
        var next = priceEl.nextElementSibling;
        var anchor =
          next &&
          next.getAttribute &&
          next.getAttribute("data-hanfwolf-pricebox-anchor") === "product"
            ? next
            : null;

        if (!anchor) {
          anchor = document.createElement("div");
          anchor.setAttribute("data-hanfwolf-pricebox-anchor", "product");
          anchor.style.marginTop = "10px";
          priceEl.insertAdjacentElement("afterend", anchor);
        }

        return anchor;
      }

      return productInfoSection;
    }

    return (
      document.querySelector("form[action*='/cart/add']") ||
      document.querySelector("main") ||
      document.body
    );
  }

  async function handleProductPage() {
    var handle = getProductHandleFromPath(window.location.pathname);
    if (!handle) return;

    var target = getProductPageTarget();

    var product;
    try {
      product = await fetchVariantJson(handle);
    } catch (error) {
      return;
    }
    var productId = product && product.id ? String(product.id) : null;
    var fallbackVariantId =
      (product.selected_or_first_available_variant &&
        product.selected_or_first_available_variant.id) ||
      (product.variants && product.variants[0] && product.variants[0].id) ||
      null;

    var currentVariantId = null;
    var currentStateKey = null;

    async function refreshPrice(force) {
      var latestTarget = getProductPageTarget();
      if (latestTarget && latestTarget !== target) {
        removeProductBadge(target);
        target = latestTarget;
      }

      var selectedVariantId = getSelectedVariantIdFromPage() || fallbackVariantId;
      var selectedQuantity = getSelectedQuantityFromPage();
      if (!selectedVariantId && !productId) {
        removeProductBadge(target);
        return;
      }

      var stateKey =
        window.location.pathname +
        window.location.search +
        "#" +
        (selectedVariantId || "product-only") +
        ":qty:" +
        selectedQuantity;

      if (!force && currentStateKey === stateKey) {
        return;
      }

      currentStateKey = stateKey;
      currentVariantId = selectedVariantId ? String(selectedVariantId) : null;

      var payload = await fetchPrice(
        currentVariantId,
        productId,
        selectedQuantity,
      );
      if (!payload || !payload.ok) {
        renderMissingPriceMessage(target, payload, "product");
        return;
      }

      renderBadge(target, payload, "Custom Add to Cart Price", "product");
    }

    document.addEventListener("change", function (event) {
      var targetEl = event && event.target;
      if (!targetEl) return;
      if (targetEl.name === "id" || targetEl.name === "quantity") {
        refreshPrice(true);
      }
    });

    document.addEventListener("input", function (event) {
      var targetEl = event && event.target;
      if (!targetEl) return;
      if (targetEl.name === "quantity") {
        refreshPrice(true);
      }
    });

    document.addEventListener("variant:change", function () {
      refreshPrice(true);
    });

    var formEl = document.querySelector("form[action*='/cart/add']");
    if (formEl) {
      var observer = new MutationObserver(function () {
        refreshPrice(false);
      });
      observer.observe(formEl, {
        subtree: true,
        attributes: true,
        childList: true,
        attributeFilter: ["value", "checked", "selected", "aria-valuenow"],
      });
    }

    window.addEventListener("popstate", function () {
      refreshPrice(true);
    });

    setInterval(function () {
      refreshPrice(false);
    }, 1000);

    refreshPrice(true);
  }

  async function handleCollectionAllPage() {
    var links = Array.prototype.slice.call(
      document.querySelectorAll("a[href*='/products/']"),
    );

    var seen = Object.create(null);
    var handles = [];

    links.forEach(function (link) {
      var match = link.getAttribute("href").match(/\/products\/([^\/?#]+)/i);
      if (!match || !match[1]) return;
      var handle = match[1];
      if (seen[handle]) return;
      seen[handle] = true;
      handles.push(handle);
    });

    var limited = handles.slice(0, 8);

    for (var i = 0; i < limited.length; i += 1) {
      var handle = limited[i];
      try {
        var product = await fetchVariantJson(handle);
        var productId = product && product.id ? String(product.id) : null;
        var firstVariant =
          product.variants && product.variants[0] && product.variants[0].id;
        if (!firstVariant && !productId) continue;

        var payload = await fetchPrice(
          firstVariant ? String(firstVariant) : null,
          productId,
          defaultQuantity || 1,
        );
        if (!payload || !payload.ok) continue;

        var productLink = document.querySelector("a[href*='/products/" + handle + "']");
        if (!productLink) continue;

        var card =
          productLink.closest("li") ||
          productLink.closest("article") ||
          productLink.parentElement;

        renderBadge(card, payload, "Custom Price", "collection-" + handle);
      } catch (error) {
        // Keep iterating if individual products fail.
      }
    }
  }

  var path = window.location.pathname;
  if (/\/products\//i.test(path)) {
    handleProductPage();
  }

  if (/\/collections\/all/i.test(path)) {
    handleCollectionAllPage();
  }

  bindCartCheckout();

  window.HanfwolfPricing = window.HanfwolfPricing || {};
  window.HanfwolfPricing.addRopeCutToCart = addRopeCutToCart;
  window.HanfwolfPricing.finalizeCart = finalizeCart;
})();`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await request.text();

  return new Response(scriptBody, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
