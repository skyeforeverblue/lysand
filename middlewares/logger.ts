import { dualLogger } from "@/loggers";
import type { SocketAddress } from "bun";
import { createMiddleware } from "hono/factory";
import { config } from "~/packages/config-manager";

export const logger = createMiddleware(async (context, next) => {
    const request_ip = context.env?.ip as SocketAddress | undefined | null;

    if (config.logging.log_requests) {
        await dualLogger.logRequest(
            context.req.raw,
            config.logging.log_ip ? request_ip?.address : undefined,
            config.logging.log_requests_verbose,
        );
    }

    await next();
});
