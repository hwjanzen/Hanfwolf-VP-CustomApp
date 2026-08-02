import { adminGraphql } from "./shopify-graphql.server";

const PRICE_LIST_HEADER_TYPE = "price_list_header";
const PRICE_LIST_LINE_TYPE = "price_list_line";

type UserError = {
  field?: string[];
  message: string;
  code?: string;
};

type BootstrapStatus = "created" | "exists";

export type BootstrapResult = {
  headerDefinition: BootstrapStatus;
  lineDefinition: BootstrapStatus;
  companyMetafieldDefinition: BootstrapStatus;
};

type EnsureDefinitionResult = {
  status: BootstrapStatus;
  id: string;
};

function assertNoUserErrors(userErrors: UserError[] | undefined, context: string) {
  if (!userErrors?.length) return;

  const details = userErrors
    .map((error) => {
      const field = error.field?.length ? `${error.field.join(".")}: ` : "";
      const code = error.code ? `[${error.code}] ` : "";
      return `${field}${code}${error.message}`;
    })
    .join("; ");

  throw new Error(`${context}: ${details}`);
}

async function getMetaobjectDefinitionByType(admin: any, type: string) {
  const result = await adminGraphql<{
    metaobjectDefinitionByType: { id: string } | null;
  }>(
    admin,
    `#graphql
    query BootstrapMetaobjectDefinitionByType($type: String!) {
      metaobjectDefinitionByType(type: $type) {
        id
      }
    }`,

    { type },
  );

  if (!result.ok) {
    throw new Error(
      `Failed to read metaobject definition \"${type}\": ${result.errors.join(" | ")}`,
    );
  }

  return result.data.metaobjectDefinitionByType;
}

async function ensurePriceListHeaderDefinition(
  admin: any,
): Promise<EnsureDefinitionResult> {
  const existing = await getMetaobjectDefinitionByType(admin, PRICE_LIST_HEADER_TYPE);
  if (existing?.id) {
    return { status: "exists", id: existing.id };
  }

  const createResult = await adminGraphql<{
    metaobjectDefinitionCreate: {
      metaobjectDefinition: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation BootstrapCreatePriceListHeaderDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition {
          id
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      definition: {
        name: "Price List Header",
        type: PRICE_LIST_HEADER_TYPE,
        displayNameKey: "name",
        fieldDefinitions: [
          {
            key: "name",
            name: "Name",
            type: "single_line_text_field",
            required: true,
          },
          {
            key: "valid_from",
            name: "Valid From",
            type: "date",
          },
          {
            key: "valid_to",
            name: "Valid To",
            type: "date",
          },
        ],
      },
    },
  );

  if (!createResult.ok) {
    throw new Error(
      `Failed to create metaobject definition \"${PRICE_LIST_HEADER_TYPE}\": ${createResult.errors.join(" | ")}`,
    );
  }

  assertNoUserErrors(
    createResult.data.metaobjectDefinitionCreate.userErrors,
    `Failed to create metaobject definition \"${PRICE_LIST_HEADER_TYPE}\"`,
  );

  if (!createResult.data.metaobjectDefinitionCreate.metaobjectDefinition?.id) {
    throw new Error(
      `Create metaobject definition \"${PRICE_LIST_HEADER_TYPE}\" returned no id.`,
    );
  }

  return {
    status: "created",
    id: createResult.data.metaobjectDefinitionCreate.metaobjectDefinition.id,
  };
}

async function ensurePriceListLineDefinition(
  admin: any,
  headerDefinitionId: string,
): Promise<BootstrapStatus> {
  const existing = await getMetaobjectDefinitionByType(admin, PRICE_LIST_LINE_TYPE);
  if (existing?.id) return "exists";

  const createResult = await adminGraphql<{
    metaobjectDefinitionCreate: {
      metaobjectDefinition: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation BootstrapCreatePriceListLineDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition {
          id
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      definition: {
        name: "Price List Line",
        type: PRICE_LIST_LINE_TYPE,
        fieldDefinitions: [
          {
            key: "price_list_header",
            name: "Price List Header",
            type: "metaobject_reference",
            required: true,
            validations: [
              {
                name: "metaobject_definition_id",
                value: headerDefinitionId,
              },
            ],
          },
          {
            key: "product",
            name: "Product",
            type: "product_reference",
          },
          {
            key: "variant",
            name: "Variant",
            type: "variant_reference",
          },
          {
            key: "quantity",
            name: "Quantity",
            type: "number_integer",
            required: true,
          },
          {
            key: "unit_price",
            name: "Unit Price",
            type: "number_decimal",
            required: true,
          },
        ],
      },
    },
  );

  if (!createResult.ok) {
    throw new Error(
      `Failed to create metaobject definition \"${PRICE_LIST_LINE_TYPE}\": ${createResult.errors.join(" | ")}`,
    );
  }

  assertNoUserErrors(
    createResult.data.metaobjectDefinitionCreate.userErrors,
    `Failed to create metaobject definition \"${PRICE_LIST_LINE_TYPE}\"`,
  );

  if (!createResult.data.metaobjectDefinitionCreate.metaobjectDefinition?.id) {
    throw new Error(
      `Create metaobject definition \"${PRICE_LIST_LINE_TYPE}\" returned no id.`,
    );
  }

  return "created";
}

async function ensureCompanyPriceListMetafieldDefinition(
  admin: any,
  headerDefinitionId: string,
): Promise<BootstrapStatus> {
  const existingResult = await adminGraphql<{
    metafieldDefinitions: {
      nodes: Array<{ id: string }>;
    };
  }>(
    admin,
    `#graphql
    query BootstrapCompanyPriceListMetafieldDefinition {
      metafieldDefinitions(
        first: 1
        ownerType: COMPANY
        namespace: "custom"
        key: "price_list"
      ) {
        nodes {
          id
        }
      }
    }`,
  );

  if (!existingResult.ok) {
    throw new Error(
      `Failed to read company metafield definition custom.price_list: ${existingResult.errors.join(" | ")}`,
    );
  }

  if (existingResult.data.metafieldDefinitions.nodes.length > 0) return "exists";

  const createWithValidation = await adminGraphql<{
    metafieldDefinitionCreate: {
      createdDefinition: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation BootstrapCreateCompanyPriceListMetafield($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition {
          id
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      definition: {
        name: "Price List",
        namespace: "custom",
        key: "price_list",
        ownerType: "COMPANY",
        type: "metaobject_reference",
        validations: [
          {
            name: "metaobject_definition_id",
            value: headerDefinitionId,
          },
        ],
      },
    },
  );

  if (!createWithValidation.ok) {
    throw new Error(
      `Failed to create company metafield definition custom.price_list: ${createWithValidation.errors.join(" | ")}`,
    );
  }

  assertNoUserErrors(
    createWithValidation.data.metafieldDefinitionCreate.userErrors,
    "Failed to create company metafield definition custom.price_list",
  );

  if (!createWithValidation.data.metafieldDefinitionCreate.createdDefinition?.id) {
    throw new Error(
      "Create company metafield definition custom.price_list returned no id.",
    );
  }

  return "created";
}

export async function ensurePricingBootstrap(admin: any): Promise<BootstrapResult> {
  const headerDefinition = await ensurePriceListHeaderDefinition(admin);
  const lineDefinition = await ensurePriceListLineDefinition(admin, headerDefinition.id);
  const companyMetafieldDefinition = await ensureCompanyPriceListMetafieldDefinition(
    admin,
    headerDefinition.id,
  );

  return {
    headerDefinition: headerDefinition.status,
    lineDefinition,
    companyMetafieldDefinition,
  };
}
