type GraphqlErrorPayload = {
  message?: string;
  path?: Array<string | number>;
  extensions?: {
    code?: string;
  };
};

type GraphqlResponse<TData> = {
  data?: TData;
  errors?: GraphqlErrorPayload[];
};

export type GraphqlResult<TData> =
  | {
      ok: true;
      data: TData;
    }
  | {
      ok: false;
      message: string;
      errors: string[];
      statusCode?: number;
    };

function formatGraphqlError(error: GraphqlErrorPayload) {
  const code = error.extensions?.code ? `[${error.extensions.code}] ` : "";
  const path = error.path?.length ? ` @ ${error.path.join(".")}` : "";
  return `${code}${error.message || "Unknown GraphQL error"}${path}`;
}

export async function adminGraphql<TData>(
  admin: any,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlResult<TData>> {
  let response: Response;

  try {
    response = await admin.graphql(query, variables ? { variables } : undefined);
  } catch (error) {
    return {
      ok: false,
      message: "Shopify Admin GraphQL request failed before response.",
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  let payload: GraphqlResponse<TData>;
  try {
    payload = (await response.json()) as GraphqlResponse<TData>;
  } catch (error) {
    return {
      ok: false,
      message: "Shopify Admin GraphQL returned invalid JSON.",
      errors: [error instanceof Error ? error.message : String(error)],
      statusCode: response.status,
    };
  }

  const errors = (payload.errors || []).map(formatGraphqlError);
  if (!response.ok || errors.length > 0) {
    return {
      ok: false,
      message: "Shopify Admin GraphQL returned errors.",
      errors: errors.length > 0 ? errors : [`HTTP ${response.status}`],
      statusCode: response.status,
    };
  }

  return {
    ok: true,
    data: (payload.data || {}) as TData,
  };
}
