import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "hono/utils/buffer";
import {
  ConfigError,
  readSettings,
  type RawEnv,
  type Settings,
} from "./config.ts";
import { errorBody, errorResponse } from "./errors.ts";
import { passthrough, type Deps } from "./passthrough.ts";

type AppEnv = { Bindings: RawEnv; Variables: { settings: Settings } };

const CHAT_COMPLETIONS = "/v1/chat/completions";

const UNAUTHORIZED = {
  message: errorBody(
    "authentication_error",
    "unauthorized",
    "Missing or incorrect bearer token.",
  ),
};

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use(CHAT_COMPLETIONS, async (c, next) => {
    c.set("settings", await readSettings(c.env));
    await next();
  });
  // Without a caller check, anyone who found the URL could spend the Gateway's credit.
  app.use(
    CHAT_COMPLETIONS,
    bearerAuth<AppEnv>({
      verifyToken: (token, c) =>
        timingSafeEqual(token, c.var.settings.clientToken),
      noAuthenticationHeader: UNAUTHORIZED,
      invalidToken: UNAUTHORIZED,
      invalidAuthenticationHeader: {
        message: errorBody(
          "invalid_request_error",
          "invalid_authorization_header",
          "The Authorization header must be a bearer token.",
        ),
      },
    }),
  );
  app.post(CHAT_COMPLETIONS, (c) =>
    passthrough(c.req.raw, c.var.settings, deps),
  );
  app.all(CHAT_COMPLETIONS, () =>
    errorResponse(
      405,
      "invalid_request_error",
      "method_not_allowed",
      "Use POST.",
      {
        allow: "POST",
      },
    ),
  );

  app.notFound(() =>
    errorResponse(
      404,
      "invalid_request_error",
      "not_found",
      "No such endpoint.",
    ),
  );
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    // The caller learns only that something is wrong; the operator sees what.
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      return errorResponse(
        500,
        "api_error",
        "misconfigured",
        "The Worker is not configured.",
      );
    }
    console.error(error);
    return errorResponse(
      500,
      "api_error",
      "internal_error",
      "The Worker failed.",
    );
  });

  return app;
}
