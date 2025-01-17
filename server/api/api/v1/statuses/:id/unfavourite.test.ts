import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "config-manager";
import { getTestStatuses, getTestUsers, sendTestRequest } from "~/tests/utils";
import type { Status as APIStatus } from "~/types/mastodon/status";
import { meta } from "./unfavourite";

const { users, tokens, deleteUsers } = await getTestUsers(5);
const timeline = (await getTestStatuses(2, users[0])).toReversed();

afterAll(async () => {
    await deleteUsers();
});

// /api/v1/statuses/:id/unfavourite
describe(meta.route, () => {
    test("should return 401 if not authenticated", async () => {
        const response = await sendTestRequest(
            new Request(
                new URL(
                    meta.route.replace(":id", timeline[0].id),
                    config.http.base_url,
                ),
                {
                    method: "POST",
                },
            ),
        );

        expect(response.status).toBe(401);
    });

    test("should be able to unfavourite post that is not favourited", async () => {
        const response = await sendTestRequest(
            new Request(
                new URL(
                    meta.route.replace(":id", timeline[0].id),
                    config.http.base_url,
                ),
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${tokens[1].accessToken}`,
                    },
                },
            ),
        );

        expect(response.status).toBe(200);
    });

    test("should unfavourite post", async () => {
        beforeAll(async () => {
            await sendTestRequest(
                new Request(
                    new URL(
                        `/api/v1/statuses/${timeline[1].id}/favourite`,
                        config.http.base_url,
                    ),
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${tokens[1].accessToken}`,
                        },
                    },
                ),
            );
        });

        const response = await sendTestRequest(
            new Request(
                new URL(
                    meta.route.replace(":id", timeline[1].id),
                    config.http.base_url,
                ),
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${tokens[1].accessToken}`,
                    },
                },
            ),
        );

        expect(response.status).toBe(200);

        const json = (await response.json()) as APIStatus;

        expect(json.favourited).toBe(false);
        expect(json.favourites_count).toBe(0);
    });

    test("post should not be favourited when fetched", async () => {
        const response = await sendTestRequest(
            new Request(
                new URL(
                    `/api/v1/statuses/${timeline[1].id}`,
                    config.http.base_url,
                ),
                {
                    headers: {
                        Authorization: `Bearer ${tokens[1].accessToken}`,
                    },
                },
            ),
        );

        expect(response.status).toBe(200);

        const json = (await response.json()) as APIStatus;

        expect(json.favourited).toBe(false);
        expect(json.favourites_count).toBe(0);
    });
});
