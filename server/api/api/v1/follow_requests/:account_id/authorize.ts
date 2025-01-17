import { applyConfig, auth, handleZodError } from "@/api";
import { errorResponse, jsonResponse } from "@/response";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import {
    checkForBidirectionalRelationships,
    relationshipToAPI,
} from "~/database/entities/Relationship";
import {
    getRelationshipToOtherUser,
    sendFollowAccept,
} from "~/database/entities/User";
import { db } from "~/drizzle/db";
import { Relationships } from "~/drizzle/schema";
import { User } from "~/packages/database-interface/user";

export const meta = applyConfig({
    allowedMethods: ["POST"],
    route: "/api/v1/follow_requests/:account_id/authorize",
    ratelimits: {
        max: 100,
        duration: 60,
    },
    auth: {
        required: true,
    },
});

export const schemas = {
    param: z.object({
        account_id: z.string().uuid(),
    }),
};

export default (app: Hono) =>
    app.on(
        meta.allowedMethods,
        meta.route,
        zValidator("param", schemas.param, handleZodError),
        auth(meta.auth),
        async (context) => {
            const { user } = context.req.valid("header");

            if (!user) return errorResponse("Unauthorized", 401);

            const { account_id } = context.req.valid("param");

            const account = await User.fromId(account_id);

            if (!account) return errorResponse("Account not found", 404);

            // Check if there is a relationship on both sides
            await checkForBidirectionalRelationships(user, account);

            // Authorize follow request
            await db
                .update(Relationships)
                .set({
                    requested: false,
                    following: true,
                })
                .where(
                    and(
                        eq(Relationships.subjectId, user.id),
                        eq(Relationships.ownerId, account.id),
                    ),
                );

            // Update followedBy for other user
            await db
                .update(Relationships)
                .set({
                    followedBy: true,
                })
                .where(
                    and(
                        eq(Relationships.subjectId, account.id),
                        eq(Relationships.ownerId, user.id),
                    ),
                );

            const foundRelationship = await getRelationshipToOtherUser(
                user,
                account,
            );

            if (!foundRelationship)
                return errorResponse("Relationship not found", 404);

            // Check if accepting remote follow
            if (account.isRemote()) {
                // Federate follow accept
                await sendFollowAccept(account, user);
            }

            return jsonResponse(relationshipToAPI(foundRelationship));
        },
    );
