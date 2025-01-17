import { applyConfig, auth, handleZodError, jsonOrForm } from "@/api";
import { jsonResponse, response } from "@/response";
import { tempmailDomains } from "@/tempmail";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import ISO6391 from "iso-639-1";
import { z } from "zod";
import { Users } from "~/drizzle/schema";
import { config } from "~/packages/config-manager";
import { User } from "~/packages/database-interface/user";

export const meta = applyConfig({
    allowedMethods: ["POST"],
    route: "/api/v1/accounts",
    ratelimits: {
        max: 2,
        duration: 60,
    },
    auth: {
        required: false,
        oauthPermissions: ["write:accounts"],
    },
});

export const schemas = {
    form: z.object({
        username: z.string(),
        email: z.string().toLowerCase(),
        password: z.string(),
        agreement: z
            .string()
            .transform((v) => ["true", "1", "on"].includes(v.toLowerCase()))
            .or(z.boolean()),
        locale: z.string(),
        reason: z.string(),
    }),
};

export default (app: Hono) =>
    app.on(
        meta.allowedMethods,
        meta.route,
        jsonOrForm(),
        zValidator("form", schemas.form, handleZodError),
        auth(meta.auth),
        async (context) => {
            const form = context.req.valid("form");
            const { username, email, password, agreement, locale } =
                context.req.valid("form");

            if (!config.signups.registration) {
                return jsonResponse(
                    {
                        error: "Registration is disabled",
                    },
                    422,
                );
            }

            const errors: {
                details: Record<
                    string,
                    {
                        error:
                            | "ERR_BLANK"
                            | "ERR_INVALID"
                            | "ERR_TOO_LONG"
                            | "ERR_TOO_SHORT"
                            | "ERR_BLOCKED"
                            | "ERR_TAKEN"
                            | "ERR_RESERVED"
                            | "ERR_ACCEPTED"
                            | "ERR_INCLUSION";
                        description: string;
                    }[]
                >;
            } = {
                details: {
                    password: [],
                    username: [],
                    email: [],
                    agreement: [],
                    locale: [],
                    reason: [],
                },
            };

            // Check if fields are blank
            for (const value of [
                "username",
                "email",
                "password",
                "agreement",
                "locale",
                "reason",
            ]) {
                // @ts-expect-error We don't care about the type here
                if (!form[value]) {
                    errors.details[value].push({
                        error: "ERR_BLANK",
                        description: `can't be blank`,
                    });
                }
            }

            // Check if username is valid
            if (!username?.match(/^[a-z0-9_]+$/))
                errors.details.username.push({
                    error: "ERR_INVALID",
                    description:
                        "must only contain lowercase letters, numbers, and underscores",
                });

            // Check if username doesnt match filters
            if (
                config.filters.username.some((filter) =>
                    username?.match(filter),
                )
            ) {
                errors.details.username.push({
                    error: "ERR_INVALID",
                    description: "contains blocked words",
                });
            }

            // Check if username is too long
            if ((username?.length ?? 0) > config.validation.max_username_size)
                errors.details.username.push({
                    error: "ERR_TOO_LONG",
                    description: `is too long (maximum is ${config.validation.max_username_size} characters)`,
                });

            // Check if username is too short
            if ((username?.length ?? 0) < 3)
                errors.details.username.push({
                    error: "ERR_TOO_SHORT",
                    description: "is too short (minimum is 3 characters)",
                });

            // Check if username is reserved
            if (config.validation.username_blacklist.includes(username ?? ""))
                errors.details.username.push({
                    error: "ERR_RESERVED",
                    description: "is reserved",
                });

            // Check if username is taken
            if (await User.fromSql(eq(Users.username, username))) {
                errors.details.username.push({
                    error: "ERR_TAKEN",
                    description: "is already taken",
                });
            }

            // Check if email is valid
            if (
                !email?.match(
                    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
                )
            )
                errors.details.email.push({
                    error: "ERR_INVALID",
                    description: "must be a valid email address",
                });

            // Check if email is blocked
            if (
                config.validation.email_blacklist.includes(email) ||
                (config.validation.blacklist_tempmail &&
                    tempmailDomains.domains.includes(
                        (email ?? "").split("@")[1],
                    ))
            )
                errors.details.email.push({
                    error: "ERR_BLOCKED",
                    description: "is from a blocked email provider",
                });

            // Check if email is taken
            if (await User.fromSql(eq(Users.email, email)))
                errors.details.email.push({
                    error: "ERR_TAKEN",
                    description: "is already taken",
                });

            // Check if agreement is accepted
            if (!agreement)
                errors.details.agreement.push({
                    error: "ERR_ACCEPTED",
                    description: "must be accepted",
                });

            if (!locale)
                errors.details.locale.push({
                    error: "ERR_BLANK",
                    description: `can't be blank`,
                });

            if (!ISO6391.validate(locale ?? ""))
                errors.details.locale.push({
                    error: "ERR_INVALID",
                    description: "must be a valid ISO 639-1 code",
                });

            // If any errors are present, return them
            if (
                Object.values(errors.details).some((value) => value.length > 0)
            ) {
                // Error is something like "Validation failed: Password can't be blank, Username must contain only letters, numbers and underscores, Agreement must be accepted"

                const errorsText = Object.entries(errors.details)
                    .filter(([_, errors]) => errors.length > 0)
                    .map(
                        ([name, errors]) =>
                            `${name} ${errors
                                .map((error) => error.description)
                                .join(", ")}`,
                    )
                    .join(", ");
                return jsonResponse(
                    {
                        error: `Validation failed: ${errorsText}`,
                        details: Object.fromEntries(
                            Object.entries(errors.details).filter(
                                ([_, errors]) => errors.length > 0,
                            ),
                        ),
                    },
                    422,
                );
            }

            await User.fromDataLocal({
                username: username ?? "",
                password: password ?? "",
                email: email ?? "",
            });

            return response(null, 200);
        },
    );
