import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  isDateInRangeISO,
  normalizeCompanyId,
  normalizeHeaderId,
  normalizeProductId,
  normalizeVariantId,
  parseNumber,
  parsePriceListLines,
  pickWinningLine,
} from "../services/price-resolver.server";
import { ensurePricingBootstrap } from "../services/pricing-bootstrap.server";
import { adminGraphql } from "../services/shopify-graphql.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const bootstrap = await ensurePricingBootstrap(admin);
    console.info("Pricing bootstrap check completed", {
      shop: session.shop,
      bootstrap,
    });
  } catch (error) {
    console.error("Pricing bootstrap check failed", {
      shop: session.shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "importMetaobjectValues") {
    const type = String(formData.get("metaobjectType") || "").trim();
    const fieldKey = String(formData.get("fieldKey") || "").trim();
    const rawValues = String(formData.get("values") || "");
    const values = [...new Set(
      rawValues
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    )];

    if (!type || !fieldKey || values.length === 0) {
      return {
        ok: false,
        intent,
        error: "Metaobject-Typ, Feld-Key und mindestens ein Wert sind erforderlich.",
      };
    }

    const failed: Array<{ value: string; message: string }> = [];
    for (const value of values) {
      const result = await adminGraphql<{
        metaobjectCreate: {
          metaobject: { id: string } | null;
          userErrors: Array<{ message: string }>;
        };
      }>(
        admin,
        `#graphql
        mutation ImportMetaobjectValue($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject { id }
            userErrors { field message }
          }
        }`,
        { variables: { metaobject: { type, fields: [{ key: fieldKey, value }] } } },
      );

      if (!result.ok || !result.data?.metaobjectCreate?.metaobject?.id) {
        failed.push({
          value,
          message:
            result.ok
              ? result.data?.metaobjectCreate?.userErrors.map((error) => error.message).join(" ")
              : result.errors.join(" "),
        });
      }
    }

    return {
      ok: failed.length === 0,
      intent,
      createdCount: values.length - failed.length,
      skippedDuplicates:
        rawValues.split(/\r?\n/).filter((value) => value.trim()).length - values.length,
      failed,
    };
  }

  const rawCompanyId = String(formData.get("companyId") || "").trim();
  const companyId = normalizeCompanyId(rawCompanyId);
  const rawHeaderId = String(formData.get("headerId") || "").trim();
  const headerIdFromInput = normalizeHeaderId(rawHeaderId);
  const rawProductId = String(formData.get("productId") || "").trim();
  const productId = normalizeProductId(rawProductId);
  const rawVariantId = String(formData.get("variantId") || "").trim();
  const variantId = normalizeVariantId(rawVariantId);
  const quantityValue = String(formData.get("quantity") || "1").trim();
  const requestDate =
    String(formData.get("requestDate") || "").trim() ||
    new Date().toISOString().slice(0, 10);

  const quantity = parseNumber(quantityValue);
  if (
    Number.isNaN(quantity) ||
    quantity <= 0 ||
    (!companyId && !headerIdFromInput) ||
    (!variantId && !productId)
  ) {
    return {
      ok: false,
      error: "Bitte gueltige Eingaben uebergeben.",
      hints: {
        companyId:
          "Optional: gid://shopify/Company/<id>, nur <id>, oder Admin-URL mit /companies/<id>.",
        headerId:
          "Alternativ: gid://shopify/Metaobject/<id> oder nur <id> fuer Price List Header.",
        productId:
          "Optional fuer Produkte ohne Variant-Line: gid://shopify/Product/<id> oder nur <id>.",
        variantId:
          "Optional wenn productId vorhanden: gid://shopify/ProductVariant/<id>, nur <id>, oder URL mit /variants/<id>.",
        quantity: "Muss groesser als 0 sein.",
      },
      debug: {
        rawCompanyId,
        normalizedCompanyId: companyId,
        rawHeaderId,
        normalizedHeaderId: headerIdFromInput,
        rawProductId,
        normalizedProductId: productId,
        rawVariantId,
        normalizedVariantId: variantId,
        productId,
        variantId,
        quantity,
      },
    };
  }

  let selectedHeader: {
    id: string;
    name: string | null;
    validFrom: string | null;
    validTo: string | null;
    source: "company_metafield" | "manual_header_id";
  } | null = null;
  let companyName: string | null = null;
  let companyAccessError: string | null = null;

  if (companyId) {
    const companyResult = await adminGraphql<{
      company: {
        name: string | null;
        metafield: {
          reference: {
            id: string;
            nameField?: { value?: string };
            validFromField?: { value?: string };
            validToField?: { value?: string };
          } | null;
        } | null;
      } | null;
    }>(
      admin,
      `#graphql
      query HanfwolfCompanyPriceList($companyId: ID!) {
        company(id: $companyId) {
          id
          name
          metafield(namespace: "custom", key: "price_list") {
            id
            type
            reference {
              ... on Metaobject {
                id
                type
                handle
                nameField: field(key: "name") {
                  value
                }
                validFromField: field(key: "valid_from") {
                  value
                }
                validToField: field(key: "valid_to") {
                  value
                }
              }
            }
          }
        }
      }`,
      { companyId },
    );

    if (!companyResult.ok) {
      companyAccessError = companyResult.errors.join(" | ");
    } else {
      const companyNode = companyResult.data?.company;
      const headerRef = companyNode?.metafield?.reference;
      companyName = companyNode?.name || null;

      if (headerRef?.id) {
        selectedHeader = {
          id: headerRef.id,
          name: headerRef?.nameField?.value || null,
          validFrom: headerRef?.validFromField?.value || null,
          validTo: headerRef?.validToField?.value || null,
          source: "company_metafield",
        };
      }
    }
  }

  if (!selectedHeader && headerIdFromInput) {
    const headerResult = await adminGraphql<{
      metaobject: {
        id: string;
        nameField?: { value?: string };
        validFromField?: { value?: string };
        validToField?: { value?: string };
      } | null;
    }>(
      admin,
      `#graphql
      query HanfwolfHeaderById($headerId: ID!) {
        metaobject(id: $headerId) {
          id
          type
          nameField: field(key: "name") {
            value
          }
          validFromField: field(key: "valid_from") {
            value
          }
          validToField: field(key: "valid_to") {
            value
          }
        }
      }`,
      { headerId: headerIdFromInput },
    );

    if (!headerResult.ok) {
      return {
        ok: false,
        error: "Header konnte nicht geladen werden.",
        details: headerResult.errors,
      };
    }

    const headerNode = headerResult.data?.metaobject;

    if (headerNode?.id) {
      selectedHeader = {
        id: headerNode.id,
        name: headerNode?.nameField?.value || null,
        validFrom: headerNode?.validFromField?.value || null,
        validTo: headerNode?.validToField?.value || null,
        source: "manual_header_id",
      };
    }
  }

  if (!selectedHeader) {
    return {
      ok: false,
      error:
        "Kein Price List Header gefunden. Entweder custom.price_list am Unternehmen setzen oder Header ID direkt eingeben.",
      hints: {
        scopes:
          "Fuer company(...) brauchst du read_companies/read_customers und einen Store mit B2B-Zugriff.",
      },
      debug: {
        companyId,
        headerIdFromInput,
        companyAccessError,
      },
    };
  }

  const isHeaderValid = isDateInRangeISO(
    requestDate,
    selectedHeader.validFrom || undefined,
    selectedHeader.validTo || undefined,
  );

  const linesResult = await adminGraphql<{
    metaobjects: {
      nodes: Array<any>;
    };
  }>(
    admin,
    `#graphql
    query HanfwolfPriceListLines {
      metaobjects(type: "price_list_line", first: 250) {
        nodes {
          id
          headerField: field(key: "price_list_header") {
            value
            reference {
              ... on Metaobject {
                id
              }
            }
          }
          productField: field(key: "product") {
            value
            reference {
              ... on Product {
                id
              }
            }
          }
          variantField: field(key: "variant") {
            value
            reference {
              ... on ProductVariant {
                id
              }
            }
          }
          quantityField: field(key: "quantity") {
            value
          }
          unitPriceField: field(key: "unit_price") {
            value
          }
        }
      }
    }`,
  );

  if (!linesResult.ok) {
    return {
      ok: false,
      error: "Price List Lines konnten nicht geladen werden.",
      details: linesResult.errors,
    };
  }

  const allLines = (linesResult.data?.metaobjects?.nodes || []) as Array<any>;
  const parsedLines = parsePriceListLines(allLines);

  const winningLine = pickWinningLine({
    lines: parsedLines,
    headerId: selectedHeader.id,
    productId: productId || undefined,
    variantId: variantId || undefined,
    quantity,
    isHeaderValid,
  });

  const eligibleLinesCount = parsedLines.filter(
    (line) =>
      isHeaderValid &&
      line.headerId === selectedHeader.id &&
      ((variantId && line.variantId === variantId) ||
        (!line.variantId && productId && line.productId === productId)) &&
      line.quantity <= quantity,
  ).length;

  let fallbackPrice = Number.NaN;
  if (variantId) {
    const variantResult = await adminGraphql<{
      productVariant: {
        id: string;
        price: string | null;
      } | null;
    }>(
      admin,
      `#graphql
      query HanfwolfVariantFallbackPrice($variantId: ID!) {
        productVariant(id: $variantId) {
          id
          price
        }
      }`,
      { variantId },
    );

    if (!variantResult.ok) {
      return {
        ok: false,
        error: "Variant-Fallbackpreis konnte nicht geladen werden.",
        details: variantResult.errors,
      };
    }

    fallbackPrice = parseNumber(variantResult.data?.productVariant?.price);
  }

  const resolvedPrice = winningLine?.unitPrice ?? fallbackPrice;
  const hasResolvedPrice = Number.isFinite(resolvedPrice);
  if (!hasResolvedPrice) {
    return {
      ok: false,
      error:
        "Kein Preis gefunden. Fuer Fallback ohne Variant bitte Variant ID angeben oder passende Product-Line sicherstellen.",
      debug: {
        companyId,
        headerIdFromInput,
        productId,
        variantId,
        quantity,
        requestDate,
      },
    };
  }

  const addToCartTotal = hasResolvedPrice ? resolvedPrice * quantity : Number.NaN;

  return {
    ok: true,
    source: winningLine ? "price_list_line" : "variant_fallback",
    resolvedPrice,
    cartPricing: {
      unitPrice: resolvedPrice,
      quantity,
      addToCartTotal,
      isValid: hasResolvedPrice,
    },
    currencyNotice: "Shopify liefert Preise als decimal string ohne Currency-Code.",
    match: winningLine,
    header: {
      id: selectedHeader.id,
      name: selectedHeader.name,
      validFrom: selectedHeader.validFrom,
      validTo: selectedHeader.validTo,
      source: selectedHeader.source,
      isValidForDate: isHeaderValid,
    },
    debug: {
      companyId,
      companyName,
      companyAccessError,
      headerIdFromInput,
      productId,
      variantId,
      quantity,
      requestDate,
      totalLinesRead: parsedLines.length,
      eligibleLines: eligibleLinesCount,
    },
  };
};

export default function Index() {
  const fetcher = useFetcher<typeof action>();
  const importFetcher = useFetcher<typeof action>();

  const shopify = useAppBridge();
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("Preis erfolgreich ermittelt");
    }
    if (fetcher.data && !fetcher.data.ok) {
      shopify.toast.show("Preisermittlung fehlgeschlagen");
    }
  }, [fetcher.data, shopify]);

  const cartPricing =
    fetcher.data && fetcher.data.ok ? fetcher.data.cartPricing : null;
  const isImporting =
    ["loading", "submitting"].includes(importFetcher.state) &&
    importFetcher.formMethod === "POST";
  const importResult =
    importFetcher.data?.intent === "importMetaobjectValues"
      ? importFetcher.data
      : null;

  return (
    <s-page heading="Hanfwolf Custom Variant Prices">
      <s-section heading="Durchmesser importieren">
        <s-paragraph>
          Einen Wert pro Zeile eingeben. Der Feld-Key muss dem Key des Textfelds
          in der Metaobject-Definition entsprechen.
        </s-paragraph>

        <importFetcher.Form method="post">
          <input type="hidden" name="intent" value="importMetaobjectValues" />
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Metaobject-Typ"
              name="metaobjectType"
              value="enAttDurchmesser"
              required
            />
            <s-text-field
              label="Feld-Key"
              name="fieldKey"
              placeholder="z. B. durchmesser"
              required
            />
            <s-text-area
              label="Werte"
              name="values"
              value={"3mm\n5mm\n6mm\n6,4mm\n6,5mm\n7mm\n7,5mm\n8mm\n9mm\n9,2mm\n10mm\n11mm\n12mm\n12,5mm\n13mm\n14mm\n15mm\n16mm\n17mm\n18mm\n19mm\n20mm\n21mm\n22mm\n23mm\n24mm\n25mm\n26mm\n28mm\n29mm\n30mm\n32mm\n33mm\n34mm\n36mm\n38mm\n40mm\n42mm\n43mm\n48mm\n50mm"}
              required
            />
            <s-button type="submit" {...(isImporting ? { loading: true } : {})}>
              Werte importieren
            </s-button>
          </s-stack>
        </importFetcher.Form>

        {importResult && (
          <s-paragraph>
            {importResult.createdCount} Werte angelegt
            {importResult.skippedDuplicates
              ? `, ${importResult.skippedDuplicates} doppelte Eingaben ignoriert`
              : ""}
            {importResult.failed?.length
              ? `. Fehler: ${importResult.failed.map((entry) => `${entry.value}: ${entry.message}`).join("; ")}`
              : "."}
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Preis pruefen (MVP)">
        <s-paragraph>
          Diese Testmaske ermittelt den gueltigen Preis aus Company Price List
          Header, Price List Lines und Variant-Fallback.
        </s-paragraph>

        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Company ID (optional, gid://shopify/Company/...)"
              name="companyId"
            />
            <s-text-field
              label="Price List Header ID (optional, gid://shopify/Metaobject/...)"
              name="headerId"
            />
            <s-text-field
              label="Product ID (optional, gid://shopify/Product/...)"
              name="productId"
            />
            <s-text-field
              label="Variant ID (optional, gid://shopify/ProductVariant/...)"
              name="variantId"
            />
            <s-text-field
              label="Quantity"
              name="quantity"
              value="1"
              required
            />
            <s-text-field
              label="Datum (YYYY-MM-DD, optional)"
              name="requestDate"
            />
            <s-button type="submit" {...(isLoading ? { loading: true } : {})}>
              Preis ermitteln
            </s-button>
          </s-stack>
        </fetcher.Form>

        {fetcher.data && (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <code>{JSON.stringify(fetcher.data, null, 2)}</code>
            </pre>
          </s-box>
        )}

        {cartPricing && (
          <s-section heading="Add to Cart Price (Frontend Demo)">
            <s-stack direction="block" gap="base">
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-paragraph>
                  Unit Price: {cartPricing.isValid ? cartPricing.unitPrice : "n/a"}
                </s-paragraph>
                <s-paragraph>Quantity: {cartPricing.quantity}</s-paragraph>
                <s-heading>
                  Add to Cart Total: {cartPricing.isValid ? cartPricing.addToCartTotal : "n/a"}
                </s-heading>
              </s-box>
            </s-stack>
          </s-section>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
