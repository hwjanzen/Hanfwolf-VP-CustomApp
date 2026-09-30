import type { LoaderFunctionArgs } from "react-router";

import scriptBody from "../scripts/rope-configurator.js?raw";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await request.text();

  return new Response(scriptBody, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
