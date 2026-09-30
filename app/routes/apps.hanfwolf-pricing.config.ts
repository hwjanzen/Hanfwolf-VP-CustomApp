import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getRopeConfiguratorConfig } from "../services/rope-configurator-setup.server";

function formatHundredths(value: number) {
  return (value / 100).toString();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return Response.json({ ok: false, error: "App-Proxy-Sitzung fehlt." }, { status: 401 });
  }

  const config = await getRopeConfiguratorConfig(session.shop);
  return Response.json(
    {
      ok: true,
      config: {
        minLengthMeters: formatHundredths(config.minLengthHundredths),
        maxLengthMeters: formatHundredths(config.maxLengthHundredths),
        defaultLengthMeters: formatHundredths(config.defaultLengthHundredths),
        minQuantity: config.minQuantity,
        maxQuantity: config.maxQuantity,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};
