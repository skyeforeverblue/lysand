import { apiRoute, applyConfig, idValidator } from "@api";
import { errorResponse, jsonResponse } from "@response";
import { z } from "zod";
import {
    findFirstStatuses,
    isViewableByUser,
    statusToAPI,
} from "~database/entities/Status";
import { db } from "~drizzle/db";
import { notification, status } from "~drizzle/schema";

export const meta = applyConfig({
    allowedMethods: ["POST"],
    ratelimits: {
        max: 100,
        duration: 60,
    },
    route: "/api/v1/statuses/:id/reblog",
    auth: {
        required: true,
    },
});

export const schema = z.object({
    visibility: z.enum(["public", "unlisted", "private"]).default("public"),
});

/**
 * Reblogs a post
 */
export default apiRoute<typeof meta, typeof schema>(
    async (req, matchedRoute, extraData) => {
        const id = matchedRoute.params.id;
        if (!id.match(idValidator)) {
            return errorResponse("Invalid ID, must be of type UUIDv7", 404);
        }

        const { user, application } = extraData.auth;

        if (!user) return errorResponse("Unauthorized", 401);

        const { visibility } = extraData.parsedRequest;

        const foundStatus = await findFirstStatuses({
            where: (status, { eq }) => eq(status.id, id),
        });

        // Check if user is authorized to view this status (if it's private)
        if (!foundStatus || !isViewableByUser(foundStatus, user))
            return errorResponse("Record not found", 404);

        const existingReblog = await db.query.status.findFirst({
            where: (status, { and, eq }) =>
                and(
                    eq(status.authorId, user.id),
                    eq(status.reblogId, status.id),
                ),
        });

        if (existingReblog) {
            return errorResponse("Already reblogged", 422);
        }

        const newReblog = (
            await db
                .insert(status)
                .values({
                    authorId: user.id,
                    reblogId: foundStatus.id,
                    visibility,
                    sensitive: false,
                    updatedAt: new Date().toISOString(),
                    applicationId: application?.id ?? null,
                })
                .returning()
        )[0];

        if (!newReblog) {
            return errorResponse("Failed to reblog", 500);
        }

        const finalNewReblog = await findFirstStatuses({
            where: (status, { eq }) => eq(status.id, newReblog.id),
        });

        if (!finalNewReblog) {
            return errorResponse("Failed to reblog", 500);
        }

        // Create notification for reblog if reblogged user is on the same instance
        if (foundStatus.author.instanceId === user.instanceId) {
            await db.insert(notification).values({
                accountId: user.id,
                notifiedId: foundStatus.authorId,
                type: "reblog",
                statusId: foundStatus.reblogId,
            });
        }

        return jsonResponse(await statusToAPI(finalNewReblog, user));
    },
);
