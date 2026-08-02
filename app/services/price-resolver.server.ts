export type PriceListLine = {
  id: string;
  headerId: string;
  productId: string;
  variantId: string;
  quantity: number;
  unitPrice: number;
};

export function parseNumber(value: string | null | undefined) {
  if (!value) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function normalizeCompanyId(value: string) {
  const input = value.trim();
  if (!input) return null;

  if (input.startsWith("gid://shopify/Company/")) {
    return input;
  }

  if (/^\d+$/.test(input)) {
    return `gid://shopify/Company/${input}`;
  }

  const urlMatch = input.match(/\/companies\/(\d+)/i);
  if (urlMatch?.[1]) {
    return `gid://shopify/Company/${urlMatch[1]}`;
  }

  return null;
}

export function normalizeCustomerId(value: string) {
  const input = value.trim();
  if (!input) return null;

  if (input.startsWith("gid://shopify/Customer/")) {
    return input;
  }

  if (/^\d+$/.test(input)) {
    return `gid://shopify/Customer/${input}`;
  }

  const urlMatch = input.match(/\/customers\/(\d+)/i);
  if (urlMatch?.[1]) {
    return `gid://shopify/Customer/${urlMatch[1]}`;
  }

  return null;
}

export function normalizeVariantId(value: string) {
  const input = value.trim();
  if (!input) return null;

  if (input.startsWith("gid://shopify/ProductVariant/")) {
    return input;
  }

  if (/^\d+$/.test(input)) {
    return `gid://shopify/ProductVariant/${input}`;
  }

  const urlMatch = input.match(/\/variants\/(\d+)/i);
  if (urlMatch?.[1]) {
    return `gid://shopify/ProductVariant/${urlMatch[1]}`;
  }

  return null;
}

export function normalizeProductId(value: string) {
  const input = value.trim();
  if (!input) return null;

  if (input.startsWith("gid://shopify/Product/")) {
    return input;
  }

  if (/^\d+$/.test(input)) {
    return `gid://shopify/Product/${input}`;
  }

  const urlMatch = input.match(/\/products\/(\d+)/i);
  if (urlMatch?.[1]) {
    return `gid://shopify/Product/${urlMatch[1]}`;
  }

  return null;
}

export function normalizeHeaderId(value: string) {
  const input = value.trim();
  if (!input) return null;

  if (input.startsWith("gid://shopify/Metaobject/")) {
    return input;
  }

  if (/^\d+$/.test(input)) {
    return `gid://shopify/Metaobject/${input}`;
  }

  return null;
}

export function isDateInRangeISO(dateISO: string, fromISO?: string, toISO?: string) {
  if (!fromISO && !toISO) return true;

  const date = new Date(dateISO);
  const from = fromISO ? new Date(fromISO) : null;
  const to = toISO ? new Date(toISO) : null;

  if (Number.isNaN(date.getTime())) return false;
  if (from && Number.isNaN(from.getTime())) return false;
  if (to && Number.isNaN(to.getTime())) return false;

  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export function parsePriceListLines(nodes: Array<any>): PriceListLine[] {
  return nodes
    .map((line) => {
      const headerId =
        line?.headerField?.reference?.id || line?.headerField?.value || "";
      const productId =
        line?.productField?.reference?.id || line?.productField?.value || "";
      const variantId =
        line?.variantField?.reference?.id || line?.variantField?.value || "";
      const quantity = parseNumber(line?.quantityField?.value);
      const unitPrice = parseNumber(line?.unitPriceField?.value);

      return {
        id: String(line.id),
        headerId: String(headerId),
        productId: String(productId),
        variantId: String(variantId),
        quantity,
        unitPrice,
      };
    })
    .filter(
      (line) =>
        line.headerId &&
        (line.variantId || line.productId) &&
        !Number.isNaN(line.quantity) &&
        !Number.isNaN(line.unitPrice),
    );
}

type PickLineParams = {
  lines: PriceListLine[];
  headerId: string;
  variantId?: string;
  productId?: string;
  quantity: number;
  isHeaderValid: boolean;
};

export function pickWinningLine({
  lines,
  headerId,
  variantId,
  productId,
  quantity,
  isHeaderValid,
}: PickLineParams) {
  if (!isHeaderValid) return null;

  const eligibleLines = lines
    .filter((line) => {
      if (line.headerId !== headerId || line.quantity > quantity) {
        return false;
      }

      if (variantId && line.variantId && line.variantId === variantId) {
        return true;
      }

      if (!line.variantId && productId && line.productId === productId) {
        return true;
      }

      return false;
    })
    .sort((a, b) => {
      const aMatchScore = a.variantId ? 2 : 1;
      const bMatchScore = b.variantId ? 2 : 1;
      if (aMatchScore !== bMatchScore) return bMatchScore - aMatchScore;
      if (a.quantity !== b.quantity) return b.quantity - a.quantity;
      return b.unitPrice - a.unitPrice;
    });

  return eligibleLines[0] || null;
}
