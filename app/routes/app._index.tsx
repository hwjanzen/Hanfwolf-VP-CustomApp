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
<<<<<<< HEAD
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
=======

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
>>>>>>> 985a519 (feat: initialize hello-world-app with Shopify integration and Prisma setup)

  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
<<<<<<< HEAD
  const formData = await request.formData();
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
=======
  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
            demoInfo: metafield(namespace: "$app", key: "demo_info") {
              jsonValue
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
          metafields: [
            {
              namespace: "$app",
              key: "demo_info",
              value: "Created by React Router Template",
            },
          ],
        },
      },
    },
  );
  const responseJson = await response.json();

  const product = responseJson.data!.productCreate!.product!;
  const variantId = product.variants.edges[0]!.node!.id!;

  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );

  const variantResponseJson = await variantResponse.json();

  const metaobjectResponse = await admin.graphql(
    `#graphql
    mutation shopifyReactRouterTemplateUpsertMetaobject($handle: MetaobjectHandleInput!, $values: JSON!) {
      metaobjectUpsert(handle: $handle, values: $values) {
        metaobject {
          id
          handle
          values
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        handle: {
          type: "$app:example",
          handle: "demo-entry",
        },
        values: {
          title: "Demo Entry",
          description:
            "This metaobject was created by the Shopify app template to demonstrate the metaobject API.",
        },
      },
    },
  );

  const metaobjectResponseJson = await metaobjectResponse.json();

  return {
    product: responseJson!.data!.productCreate!.product,
    variant:
      variantResponseJson!.data!.productVariantsBulkUpdate!.productVariants,
    metaobject: metaobjectResponseJson!.data!.metaobjectUpsert!.metaobject,
>>>>>>> 985a519 (feat: initialize hello-world-app with Shopify integration and Prisma setup)
  };
};

export default function Index() {
  const fetcher = useFetcher<typeof action>();

  const shopify = useAppBridge();
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
<<<<<<< HEAD
    if (fetcher.data?.ok) {
      shopify.toast.show("Preis erfolgreich ermittelt");
    }
    if (fetcher.data && !fetcher.data.ok) {
      shopify.toast.show("Preisermittlung fehlgeschlagen");
    }
  }, [fetcher.data, shopify]);

  const cartPricing =
    fetcher.data && fetcher.data.ok ? fetcher.data.cartPricing : null;

  return (
    <s-page heading="Hanfwolf Custom Variant Prices">
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
=======
    if (fetcher.data?.product?.id) {
      shopify.toast.show("Product created");
    }
  }, [fetcher.data?.product?.id, shopify]);

  const generateProduct = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page heading="Shopify app template">
      <s-button slot="primary-action" onClick={generateProduct}>
        Generate a product
      </s-button>

      <s-section heading="Congrats on creating a new Shopify app 🎉">
        <s-paragraph>
          This embedded app template uses{" "}
          <s-link
            href="https://shopify.dev/docs/apps/tools/app-bridge"
            target="_blank"
          >
            App Bridge
          </s-link>{" "}
          interface examples like an{" "}
          <s-link href="/app/additional">additional page in the app nav</s-link>
          , as well as an{" "}
          <s-link
            href="https://shopify.dev/docs/api/admin-graphql"
            target="_blank"
          >
            Admin GraphQL
          </s-link>{" "}
          mutation demo, to provide a starting point for app development.
        </s-paragraph>
      </s-section>
      <s-section heading="Get started with products">
        <s-paragraph>
          Generate a product with GraphQL and get the JSON output for that
          product. Learn more about the{" "}
          <s-link
            href="https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate"
            target="_blank"
          >
            productCreate
          </s-link>{" "}
          mutation in our API references. Includes a product{" "}
          <s-link
            href="https://shopify.dev/docs/apps/build/custom-data/metafields"
            target="_blank"
          >
            metafield
          </s-link>{" "}
          and{" "}
          <s-link
            href="https://shopify.dev/docs/apps/build/custom-data/metaobjects"
            target="_blank"
          >
            metaobject
          </s-link>
          .
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={generateProduct}
            {...(isLoading ? { loading: true } : {})}
          >
            Generate a product
          </s-button>
          {fetcher.data?.product && (
            <s-button
              onClick={() => {
                shopify.intents.invoke?.("edit:shopify/Product", {
                  value: fetcher.data?.product?.id,
                });
              }}
              target="_blank"
              variant="tertiary"
            >
              Edit product
            </s-button>
          )}
        </s-stack>
        {fetcher.data?.product && (
          <s-section heading="productCreate mutation">
>>>>>>> 985a519 (feat: initialize hello-world-app with Shopify integration and Prisma setup)
            <s-stack direction="block" gap="base">
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
<<<<<<< HEAD
                <s-paragraph>
                  Unit Price: {cartPricing.isValid ? cartPricing.unitPrice : "n/a"}
                </s-paragraph>
                <s-paragraph>Quantity: {cartPricing.quantity}</s-paragraph>
                <s-heading>
                  Add to Cart Total: {cartPricing.isValid ? cartPricing.addToCartTotal : "n/a"}
                </s-heading>
=======
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  <code>{JSON.stringify(fetcher.data.product, null, 2)}</code>
                </pre>
              </s-box>

              <s-heading>productVariantsBulkUpdate mutation</s-heading>
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
                  <code>{JSON.stringify(fetcher.data.variant, null, 2)}</code>
                </pre>
              </s-box>

              <s-heading>metaobjectUpsert mutation</s-heading>
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
                  <code>
                    {JSON.stringify(fetcher.data.metaobject, null, 2)}
                  </code>
                </pre>
>>>>>>> 985a519 (feat: initialize hello-world-app with Shopify integration and Prisma setup)
              </s-box>
            </s-stack>
          </s-section>
        )}
      </s-section>
<<<<<<< HEAD
=======

      <s-section slot="aside" heading="App template specs">
        <s-paragraph>
          <s-text>Framework: </s-text>
          <s-link href="https://reactrouter.com/" target="_blank">
            React Router
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Interface: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/app-home/using-polaris-components"
            target="_blank"
          >
            Polaris web components
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>API: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/admin-graphql"
            target="_blank"
          >
            GraphQL
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Custom data: </s-text>
          <s-link
            href="https://shopify.dev/docs/apps/build/custom-data"
            target="_blank"
          >
            Metafields &amp; metaobjects
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Database: </s-text>
          <s-link href="https://www.prisma.io/" target="_blank">
            Prisma
          </s-link>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Next steps">
        <s-unordered-list>
          <s-list-item>
            Build an{" "}
            <s-link
              href="https://shopify.dev/docs/apps/getting-started/build-app-example"
              target="_blank"
            >
              example app
            </s-link>
          </s-list-item>
          <s-list-item>
            Explore Shopify&apos;s API with{" "}
            <s-link
              href="https://shopify.dev/docs/apps/tools/graphiql-admin-api"
              target="_blank"
            >
              GraphiQL
            </s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
>>>>>>> 985a519 (feat: initialize hello-world-app with Shopify integration and Prisma setup)
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
