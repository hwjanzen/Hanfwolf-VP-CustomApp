(function () {
  var script = document.currentScript;
  if (!script) return;

  var form = document.getElementById(script.dataset.formId || "");
  if (!form || form.dataset.initialized === "true") return;
  form.dataset.initialized = "true";

  var section = form.closest("[data-rope-configurator-section]");
  var cutsContainer = form.querySelector("[data-rope-cuts]");
  var template = section && section.querySelector("[data-rope-cut-template]");
  var errorElement = form.querySelector("[data-rope-error]");
  var prepareButton = form.querySelector("[data-prepare-rope]");
  var submitButton = form.querySelector("[data-rope-submit]");
  var productId = script.dataset.productId;
  var cartUrl = script.dataset.cartUrl || "/cart";
  var configUrl = script.dataset.configUrl || "/apps/hanfwolf-pricing/config";
  var nextIndex = 0;

  if (!section || !cutsContainer || !template || !errorElement || !prepareButton || !submitButton || !productId) {
    return;
  }

  submitButton.disabled = true;

  function getItems() {
    return Array.from(cutsContainer.querySelectorAll(".rope-cut")).map(function (cut) {
      return {
        productId: productId,
        quantity: Number(cut.querySelector("[data-rope-quantity]").value),
        lengthMeters: cut.querySelector("[data-rope-length]").value,
        presentation: cut.querySelector("[data-rope-presentation]:checked").value,
      };
    });
  }

  function markConfigurationChanged() {
    submitButton.disabled = true;
    prepareButton.disabled = false;
    prepareButton.textContent = "Konfiguration abschließen";
  }

  function updateRemoveButtons() {
    var cuts = cutsContainer.querySelectorAll(".rope-cut");
    cuts.forEach(function (cut) {
      cut.querySelector("[data-remove-rope-cut]").hidden = cuts.length === 1;
    });
  }

  function addCut() {
    var fragment = template.content.cloneNode(true);
    var cut = fragment.querySelector(".rope-cut");
    var index = nextIndex++;
    var quantity = cut.querySelector("[data-rope-quantity]");
    var length = cut.querySelector("[data-rope-length]");
    var radios = cut.querySelectorAll("[data-rope-presentation]");

    quantity.id = "RopeQuantity-" + script.dataset.sectionId + "-" + index;
    length.id = "RopeLength-" + script.dataset.sectionId + "-" + index;
    cut.querySelector("[data-quantity-label]").htmlFor = quantity.id;
    cut.querySelector("[data-length-label]").htmlFor = length.id;
    radios.forEach(function (radio) {
      radio.name = "rope-presentation-" + script.dataset.sectionId + "-" + index;
    });

    cut.querySelector("[data-remove-rope-cut]").addEventListener("click", function () {
      cut.remove();
      updateRemoveButtons();
      markConfigurationChanged();
    });
    quantity.addEventListener("input", markConfigurationChanged);
    length.addEventListener("input", markConfigurationChanged);
    radios.forEach(function (radio) {
      radio.addEventListener("change", markConfigurationChanged);
    });

    cutsContainer.appendChild(fragment);
    updateRemoveButtons();
    markConfigurationChanged();
  }

  function showError(message) {
    errorElement.textContent = message;
    errorElement.hidden = !message;
  }

  async function applySetup() {
    try {
      var response = await fetch(configUrl, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      var payload = await response.json();
      if (!payload.ok || !payload.config) return;

      var quantity = template.content.querySelector("[data-rope-quantity]");
      var length = template.content.querySelector("[data-rope-length]");
      quantity.min = String(payload.config.minQuantity);
      quantity.max = String(payload.config.maxQuantity);
      quantity.value = String(payload.config.minQuantity);
      length.min = payload.config.minLengthMeters;
      length.max = payload.config.maxLengthMeters;
      length.value = payload.config.defaultLengthMeters;
    } catch (error) {
      console.warn("RopeConfigurator Setup konnte nicht geladen werden", error);
    }
  }

  form.querySelector("[data-add-rope-cut]").addEventListener("click", addCut);

  prepareButton.addEventListener("click", async function () {
    showError("");
    if (!form.reportValidity()) return;

    var prepareRopeCut = window.HanfwolfPricing && window.HanfwolfPricing.prepareRopeCut;
    if (!prepareRopeCut) {
      showError("Der Hanfwolf-Warenkorbservice wurde nicht geladen.");
      return;
    }

    prepareButton.disabled = true;
    submitButton.disabled = true;
    prepareButton.textContent = "Zuschnitte werden erstellt und synchronisiert ...";

    try {
      await Promise.all(getItems().map(function (item) {
        return prepareRopeCut(item);
      }));
      prepareButton.textContent = "Konfiguration bestätigt";
      submitButton.disabled = false;
    } catch (error) {
      prepareButton.disabled = false;
      prepareButton.textContent = "Konfiguration abschließen";
      showError(error instanceof Error ? error.message : "Die Zuschnitte konnten nicht vorbereitet werden.");
    }
  });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    showError("");
    if (!form.reportValidity()) return;

    var items = getItems();
    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");

    try {
      if (!window.HanfwolfPricing || !window.HanfwolfPricing.addRopeCutToCart) {
        throw new Error("Der Hanfwolf-Warenkorbservice wurde nicht geladen.");
      }

      for (var index = 0; index < items.length; index += 1) {
        await window.HanfwolfPricing.addRopeCutToCart(items[index]);
      }
      window.location.assign(cartUrl);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Der Zuschnitt konnte nicht in den Warenkorb gelegt werden.");
      submitButton.disabled = false;
      submitButton.removeAttribute("aria-busy");
    }
  });

  applySetup().finally(addCut);
})();
