import {
    applyConfig,
    auth,
    emojiValidator,
    handleZodError,
    jsonOrForm,
} from "@/api";
import { mimeLookup } from "@/content_types";
import { errorResponse, jsonResponse, response } from "@/response";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { getUrl } from "~/database/entities/Attachment";
import { emojiToAPI } from "~/database/entities/Emoji";
import { db } from "~/drizzle/db";
import { Emojis } from "~/drizzle/schema";
import { config } from "~/packages/config-manager";
import { MediaBackend } from "~/packages/media-manager";

export const meta = applyConfig({
    allowedMethods: ["DELETE", "GET", "PATCH"],
    route: "/api/v1/emojis/:id",
    ratelimits: {
        max: 30,
        duration: 60,
    },
    auth: {
        required: true,
    },
});

export const schemas = {
    param: z.object({
        id: z.string().uuid(),
    }),
    form: z
        .object({
            shortcode: z
                .string()
                .trim()
                .min(1)
                .max(64)
                .regex(
                    emojiValidator,
                    "Shortcode must only contain letters (any case), numbers, dashes or underscores.",
                ),
            element: z
                .string()
                .trim()
                .min(1)
                .max(2000)
                .url()
                .or(z.instanceof(File)),
            category: z.string().max(64).optional(),
            alt: z.string().max(1000).optional(),
            global: z
                .string()
                .transform((v) => ["true", "1", "on"].includes(v.toLowerCase()))
                .or(z.boolean())
                .optional(),
        })
        .partial()
        .optional(),
};

export default (app: Hono) =>
    app.on(
        meta.allowedMethods,
        meta.route,
        jsonOrForm(),
        zValidator("param", schemas.param, handleZodError),
        zValidator("form", schemas.form, handleZodError),
        auth(meta.auth),
        async (context) => {
            const { id } = context.req.valid("param");
            const { user } = context.req.valid("header");

            if (!user) {
                return errorResponse("Unauthorized", 401);
            }

            const emoji = await db.query.Emojis.findFirst({
                where: (emoji, { eq }) => eq(emoji.id, id),
                with: {
                    instance: true,
                },
            });

            if (!emoji) return errorResponse("Emoji not found", 404);

            // Check if user is admin
            if (
                !user.getUser().isAdmin &&
                emoji.ownerId !== user.getUser().id
            ) {
                return jsonResponse(
                    {
                        error: "You do not have permission to modify this emoji, as it is either global or not owned by you",
                    },
                    403,
                );
            }

            switch (context.req.method) {
                case "DELETE": {
                    const mediaBackend = await MediaBackend.fromBackendType(
                        config.media.backend,
                        config,
                    );

                    await mediaBackend.deleteFileByUrl(emoji.url);

                    await db.delete(Emojis).where(eq(Emojis.id, id));

                    return response(null, 204);
                }

                case "PATCH": {
                    const form = context.req.valid("form");

                    if (!form) {
                        return errorResponse(
                            "Invalid form data (must supply at least one of: shortcode, element, alt, category)",
                            422,
                        );
                    }

                    if (
                        !form.shortcode &&
                        !form.element &&
                        !form.alt &&
                        !form.category &&
                        form.global === undefined
                    ) {
                        return errorResponse(
                            "Invalid form data (must supply shortcode and/or element and/or alt and/or global)",
                            422,
                        );
                    }

                    if (!user.getUser().isAdmin && form.global) {
                        return errorResponse(
                            "Only administrators can make an emoji global or not",
                            401,
                        );
                    }

                    if (form.element) {
                        // Check of emoji is an image
                        let contentType =
                            form.element instanceof File
                                ? form.element.type
                                : await mimeLookup(form.element);

                        if (!contentType.startsWith("image/")) {
                            return jsonResponse(
                                {
                                    error: `Emojis must be images (png, jpg, gif, etc.). Detected: ${contentType}`,
                                },
                                422,
                            );
                        }

                        let url = "";

                        if (form.element instanceof File) {
                            const media = await MediaBackend.fromBackendType(
                                config.media.backend,
                                config,
                            );

                            const uploaded = await media.addFile(form.element);

                            url = uploaded.path;
                            contentType = uploaded.uploadedFile.type;
                        } else {
                            url = form.element;
                        }

                        emoji.url = getUrl(url, config);
                        emoji.contentType = contentType;
                    }

                    const newEmoji = (
                        await db
                            .update(Emojis)
                            .set({
                                shortcode: form.shortcode ?? emoji.shortcode,
                                alt: form.alt ?? emoji.alt,
                                url: emoji.url,
                                ownerId: form.global ? null : user.id,
                                contentType: emoji.contentType,
                                category: form.category ?? emoji.category,
                            })
                            .where(eq(Emojis.id, id))
                            .returning()
                    )[0];

                    return jsonResponse(
                        emojiToAPI({
                            ...newEmoji,
                            instance: null,
                        }),
                    );
                }

                case "GET": {
                    return jsonResponse(emojiToAPI(emoji));
                }
            }
        },
    );
