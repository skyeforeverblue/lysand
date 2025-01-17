import { applyConfig, auth, handleZodError } from "@/api";
import { errorResponse, jsonResponse } from "@/response";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import { deleteLike } from "~/database/entities/Like";
import { Note } from "~/packages/database-interface/note";

export const meta = applyConfig({
    allowedMethods: ["POST"],
    ratelimits: {
        max: 100,
        duration: 60,
    },
    route: "/api/v1/statuses/:id/unfavourite",
    auth: {
        required: true,
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

            if (!user) return errorResponse("Unauthorized", 401);

            const note = await Note.fromId(id, user.id);

            if (!note?.isViewableByUser(user))
                return errorResponse("Record not found", 404);

            await deleteLike(user, note);

            const newNote = await Note.fromId(id, user.id);

            if (!newNote) return errorResponse("Record not found", 404);

            return jsonResponse(await newNote.toAPI(user));
        },
    );
