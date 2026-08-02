import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isDateInRangeISO,
  normalizeCompanyId,
  normalizeCustomerId,
  normalizeHeaderId,
  normalizeProductId,
  normalizeVariantId,
  parseNumber,
  parsePriceListLines,
  pickWinningLine,
} from "../services/price-resolver.server";
import { adminGraphql } from "../services/shopify-graphql.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin || !session) {
    return Response.json(
      {
        ok: false,
        error: "App proxy request has no session. Reinstall app and retry.",
      },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const rawCompanyId = url.searchParams.get("companyId") || "";
  const rawHeaderId = url.searchParams.get("headerId") || "";
  const rawProductId = url.searchParams.get("productId") || "";
  const rawVariantId = url.searchParams.get("variantId") || "";
  const quantityValue = url.searchParams.get("quantity") || "1";
  const requestDate =
    url.searchParams.get("requestDate") || new Date().toISOString().slice(0, 10);
  const marketHint = url.searchParams.get("market") || "";
  const countryHint = url.searchParams.get("country") || "";
  const localeHint = url.searchParams.get("locale") || "";
  const rawLoggedInCustomerId =
    url.searchParams.get("logged_in_customer_id") ||
    url.searchParams.get("customer_id") ||
    "";

  const companyIdFromInput = normalizeCompanyId(rawCompanyId);
  const loggedInCustomerId = normalizeCustomerId(rawLoggedInCustomerId);
  const headerIdFromInput = normalizeHeaderId(rawHeaderId);
  const productId = normalizeProductId(rawProductId);
  const variantId = normalizeVariantId(rawVariantId);
  const quantity = parseNumber(quantityValue);

  const debugContext: any = {
    request: {
      rawCompanyId,
      rawHeaderId,
      rawProductId,
      rawVariantId,
      rawLoggedInCustomerId,
      quantityValue,
      requestDate,
      marketHint,
      countryHint,
      localeHint,
    },
    normalized: {
      companyIdFromInput,
      headerIdFromInput,
      productId,
      variantId,
      loggedInCustomerId,
      quantity,
    },
    session: {
      shop: session.shop,
    },
    customerContext: null,
    companyContext: null,
    resolver: {
      effectiveCompanyId: null,
      usedPath: "none",
    },
  };

  let effectiveCompanyId = companyIdFromInput;
  let isProtectedCustomerDataBlocked = false;

  if (loggedInCustomerId) {
    const customerCompanyResult = await adminGraphql<{
      customer: {
        id: string;
        companyContactProfiles: Array<{
          id: string;
          company: {
            id: string;
            name: string;
          } | null;
        }>;
      } | null;
    }>(
      admin,
      `#graphql
      query HanfwolfProxyCustomerCompany($customerId: ID!) {
        customer(id: $customerId) {
          id
          companyContactProfiles {
            id
            company {
              id
              name
            }
          }
        }
      }`,
      { customerId: loggedInCustomerId },
    );

    if (!customerCompanyResult.ok) {
      console.warn("Failed to resolve company from logged-in customer", {
        loggedInCustomerId,
        errors: customerCompanyResult.errors,
      });
      isProtectedCustomerDataBlocked = customerCompanyResult.errors.some((error) =>
        error.includes("not approved to access the Customer object"),
      );
      debugContext.customerContext = {
        ok: false,
        errors: customerCompanyResult.errors,
        protectedCustomerDataBlocked: isProtectedCustomerDataBlocked,
      };
    } else {
      const customerNode = customerCompanyResult.data.customer;
      debugContext.customerContext = {
        ok: true,
        customerId: customerNode?.id || null,
        companyProfiles:
          customerNode?.companyContactProfiles?.map((node) => ({
            profileId: node.id,
            companyId: node.company?.id || null,
            companyName: node.company?.name || null,
          })) || [],
      };

      if (!effectiveCompanyId && !headerIdFromInput) {
        effectiveCompanyId =
          customerNode?.companyContactProfiles?.[0]?.company?.id || null;
      }
    }
  }

  if (companyIdFromInput) {
    debugContext.resolver.usedPath = "company_id_from_input";
  } else if (effectiveCompanyId) {
    debugContext.resolver.usedPath = "customer_to_company";
  }
  debugContext.resolver.effectiveCompanyId = effectiveCompanyId;

  if (Number.isNaN(quantity) || quantity <= 0 || (!variantId && !productId)) {
    return Response.json(
      {
        ok: false,
        error: "Invalid input.",
        hints: {
          companyId:
            "Optional: gid://shopify/Company/<id> or numeric id. If omitted, logged-in B2B customer context is used.",
          headerId:
            "Optional fallback: gid://shopify/Metaobject/<id> or numeric id.",
          productId:
            "Optional for product-based lines: gid://shopify/Product/<id> or numeric id.",
          variantId:
            "Optional when productId exists: gid://shopify/ProductVariant/<id> or numeric id.",
          quantity: "Must be greater than 0.",
        },
        debug: debugContext,
      },
      { status: 400 },
    );
  }

  if (!effectiveCompanyId && !headerIdFromInput) {
    const reason = isProtectedCustomerDataBlocked
      ? "protected_customer_data_not_approved"
      : "missing_pricing_context";
    const error = isProtectedCustomerDataBlocked
      ? "Customer context blocked: app is not approved for protected customer data access. Use data-company-id fallback or request approval."
      : "No company/header context available. Logged-in B2B company or explicit headerId is required.";

    return Response.json(
      {
        ok: false,
        reason,
        error,
        debug: debugContext,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  let selectedHeader: {
    id: string;
    name: string | null;
    validFrom: string | null;
    validTo: string | null;
    source: "company_metafield" | "manual_header_id";
  } | null = null;

  if (effectiveCompanyId) {
    const companyResult = await adminGraphql<{
      company: {
        id: string;
        name: string;
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
      query HanfwolfProxyCompanyPriceList($companyId: ID!) {
        company(id: $companyId) {
          id
          name
          metafield(namespace: "custom", key: "price_list") {
            reference {
              ... on Metaobject {
                id
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
      { companyId: effectiveCompanyId },
    );

    if (!companyResult.ok) {
      console.warn("Failed to resolve company price_list metafield", {
        companyId: effectiveCompanyId,
        errors: companyResult.errors,
      });
      debugContext.companyContext = {
        ok: false,
        companyId: effectiveCompanyId,
        errors: companyResult.errors,
      };
    } else {
      const companyNode = companyResult.data.company;
      const headerRef = companyNode?.metafield?.reference;

      debugContext.companyContext = {
        ok: true,
        companyId: companyNode?.id || null,
        companyName: companyNode?.name || null,
        hasPriceListMetafield: Boolean(headerRef?.id),
        headerId: headerRef?.id || null,
      };

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
      query HanfwolfProxyHeaderById($headerId: ID!) {
        metaobject(id: $headerId) {
          id
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
      return Response.json(
        {
          ok: false,
          error: "Failed to load header by id.",
          details: headerResult.errors,
          debug: debugContext,
        },
        { status: 502 },
      );
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
    return Response.json(
      {
        ok: false,
        error: "No matching price list header found.",
        debug: debugContext,
      },
      { status: 404 },
    );
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
    query HanfwolfProxyPriceListLines {
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
    return Response.json(
      {
        ok: false,
        error: "Failed to load price list lines.",
        details: linesResult.errors,
        debug: debugContext,
      },
      { status: 502 },
    );
  }

  const parsedLines = parsePriceListLines(linesResult.data.metaobjects?.nodes || []);
  const winningLine = pickWinningLine({
    lines: parsedLines,
    headerId: selectedHeader.id,
    productId: productId || undefined,
    variantId: variantId || undefined,
    quantity,
    isHeaderValid,
  });

  let fallbackPrice = Number.NaN;
  if (variantId) {
    const variantResult = await adminGraphql<{
      productVariant: {
        price: string | null;
      } | null;
    }>(
      admin,
      `#graphql
      query HanfwolfProxyVariantPrice($variantId: ID!) {
        productVariant(id: $variantId) {
          price
        }
      }`,
      { variantId },
    );

    if (!variantResult.ok) {
      return Response.json(
        {
          ok: false,
          error: "Failed to load fallback variant price.",
          details: variantResult.errors,
          debug: debugContext,
        },
        { status: 502 },
      );
    }

    fallbackPrice = parseNumber(variantResult.data?.productVariant?.price);
  }
  const resolvedPrice = winningLine?.unitPrice ?? fallbackPrice;

  if (!Number.isFinite(resolvedPrice)) {
    return Response.json(
      {
        ok: false,
        error:
          "No price found. Provide variantId for fallback or ensure a product-based price list line exists.",
        debug: {
          ...debugContext,
          selectedHeader,
        },
      },
      { status: 404 },
    );
  }

  const body = {
    ok: true,
    source: winningLine ? "price_list_line" : "variant_fallback",
    unitPrice: resolvedPrice,
    quantity,
    addToCartTotal: Number.isFinite(resolvedPrice)
      ? resolvedPrice * quantity
      : Number.NaN,
    productId,
    variantId,
    companyId: effectiveCompanyId,
    header: {
      id: selectedHeader.id,
      name: selectedHeader.name,
      validFrom: selectedHeader.validFrom,
      validTo: selectedHeader.validTo,
      source: selectedHeader.source,
      isValidForDate: isHeaderValid,
    },
    debug: {
      ...debugContext,
      selectedHeader,
    },
  };

  return Response.json(body, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
};
