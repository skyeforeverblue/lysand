import { applyConfig, auth, handleZodError } from "@/api";
import { errorResponse, jsonResponse } from "@/response";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import { Note } from "~/packages/database-interface/note";

export const meta = applyConfig({
    allowedMethods: ["GET"],
    ratelimits: {
        max: 8,
        duration: 60,
    },
    route: "/api/v1/statuses/:id/context",
    auth: {
        required: false,
    },
});

export const schemas = {
    param: z.object({
        id: z.string().uuid(),
    }),
};

export default (app: Hono) =>
    app.on(
        meta.allowedMethods,
        meta.route,
        zValidator("param", schemas.param, handleZodError),
        auth(meta.auth),
        async (context) => {
            const { id } = context.req.valid("param");

            const { user } = context.req.valid("header");

            const foundStatus = await Note.fromId(id, user?.id);

            if (!foundStatus) return errorResponse("Record not found", 404);

            const ancestors = await foundStatus.getAncestors(user ?? null);

            const descendants = await foundStatus.getDescendants(user ?? null);

            return jsonResponse({
                ancestors: await Promise.all(
                    ancestors.map((status) => status.toAPI(user)),
                ),
                descendants: await Promise.all(
                    descendants.map((status) => status.toAPI(user)),
                ),
            });
        },
    );
