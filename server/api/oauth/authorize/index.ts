import { randomBytes } from "node:crypto";
import { apiRoute, applyConfig, idValidator } from "@api";
import { response } from "@response";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { TokenType } from "~database/entities/Token";
import { db } from "~drizzle/db";
import { Tokens } from "~drizzle/schema";
import { config } from "~packages/config-manager";
import { User } from "~packages/database-interface/user";

export const meta = applyConfig({
    allowedMethods: ["POST"],
    ratelimits: {
        max: 4,
        duration: 60,
    },
    route: "/oauth/authorize",
    auth: {
        required: false,
    },
});

export const schema = z.object({
    scope: z.string().optional(),
    redirect_uri: z.string().url().optional(),
    response_type: z.enum([
        "code",
        "token",
        "none",
        "id_token",
        "code id_token",
        "code token",
        "token id_token",
        "code token id_token",
    ]),
    client_id: z.string(),
    state: z.string().optional(),
    code_challenge: z.string().optional(),
    code_challenge_method: z.enum(["plain", "S256"]).optional(),
});

export const querySchema = z.object({
    prompt: z
        .enum(["none", "login", "consent", "select_account"])
        .optional()
        .default("none"),
    max_age: z
        .number()
        .int()
        .optional()
        .default(60 * 60 * 24 * 7),
});

const returnError = (query: object, error: string, description: string) => {
    const searchParams = new URLSearchParams();

    // Add all data that is not undefined except email and password
    for (const [key, value] of Object.entries(query)) {
        if (key !== "email" && key !== "password" && value !== undefined)
            searchParams.append(key, value);
    }

    searchParams.append("error", error);
    searchParams.append("error_description", description);

    return response(null, 302, {
        Location: `/oauth/authorize?${searchParams.toString()}`,
    });
};

/**
 * OIDC Authorization
 */
export default apiRoute<typeof meta, typeof schema>(
    async (req, matchedRoute, extraData) => {
        const {
            scope,
            redirect_uri,
            response_type,
            client_id,
            state,
            code_challenge,
            code_challenge_method,
        } = extraData.parsedRequest;

        const cookie = req.headers.get("Cookie");

        if (!cookie)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "No cookies were sent with the request",
            );

        const jwt = cookie
            .split(";")
            .find((c) => c.trim().startsWith("jwt="))
            ?.split("=")[1];

        if (!jwt)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "No jwt cookie was sent in the request",
            );

        // Try and import the key
        const privateKey = await crypto.subtle.importKey(
            "pkcs8",
            Buffer.from(config.oidc.jwt_key.split(";")[0], "base64"),
            "Ed25519",
            true,
            ["sign"],
        );

        const publicKey = await crypto.subtle.importKey(
            "spki",
            Buffer.from(config.oidc.jwt_key.split(";")[1], "base64"),
            "Ed25519",
            true,
            ["verify"],
        );

        const result = await jwtVerify(jwt, publicKey, {
            algorithms: ["EdDSA"],
            issuer: new URL(config.http.base_url).origin,
            audience: client_id,
        }).catch((e) => {
            console.error(e);
            return null;
        });

        if (!result)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "Invalid JWT, could not verify",
            );

        const payload = result.payload;

        if (!payload.sub)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "Invalid sub",
            );
        if (!payload.aud)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "Invalid aud",
            );
        if (!payload.exp)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "Invalid exp",
            );

        // Check if the user is authenticated
        const user = await User.fromId(payload.sub);

        if (!user)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "Invalid sub",
            );

        const responseTypes = response_type.split(" ");

        const asksCode = responseTypes.includes("code");
        const asksToken = responseTypes.includes("token");
        const asksIdToken = responseTypes.includes("id_token");

        if (!asksCode && !asksToken && !asksIdToken)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "Invalid response_type, must ask for code, token, or id_token",
            );

        if (asksCode && !redirect_uri)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "Redirect URI is required for code flow",
            );

        /* if (asksCode && !code_challenge)
            return returnError(
                "invalid_request",
                "Code challenge is required for code flow",
            );

        if (asksCode && !code_challenge_method)
            return returnError(
                "invalid_request",
                "Code challenge method is required for code flow",
            ); */

        // Authenticate the user
        const application = await db.query.Applications.findFirst({
            where: (app, { eq }) => eq(app.clientId, client_id),
        });

        if (!application)
            return returnError(
                extraData.parsedRequest,
                "invalid_client",
                "Invalid client_id or client_secret",
            );

        if (application.redirectUri !== redirect_uri)
            return returnError(
                extraData.parsedRequest,
                "invalid_request",
                "Redirect URI does not match client_id",
            );

        /* if (application.slate !== slate)
            return returnError("invalid_request", "Invalid slate"); */

        // Validate scopes, they can either be equal or a subset of the application's scopes
        const applicationScopes = application.scopes.split(" ");

        if (
            scope &&
            !scope.split(" ").every((s) => applicationScopes.includes(s))
        )
            return returnError(
                extraData.parsedRequest,
                "invalid_scope",
                "Invalid scope",
            );

        // Generate tokens
        const code = randomBytes(256).toString("base64url");

        // Handle the requested scopes
        let idTokenPayload = {};
        const scopeIncludesOpenID = scope?.split(" ").includes("openid");
        const scopeIncludesProfile = scope?.split(" ").includes("profile");
        const scopeIncludesEmail = scope?.split(" ").includes("email");
        if (scope) {
            const scopes = scope.split(" ");
            if (scopeIncludesOpenID) {
                // Include the standard OpenID claims
                idTokenPayload = {
                    ...idTokenPayload,
                    sub: user.id,
                    aud: client_id,
                    iss: new URL(config.http.base_url).origin,
                    iat: Math.floor(Date.now() / 1000),
                    exp: Math.floor(Date.now() / 1000) + 60 * 60,
                };
            }
            if (scopeIncludesProfile) {
                // Include the user's profile information
                idTokenPayload = {
                    ...idTokenPayload,
                    name: user.getUser().displayName,
                    preferred_username: user.getUser().username,
                    picture: user.getAvatarUrl(config),
                    updated_at: new Date(
                        user.getUser().updatedAt,
                    ).toISOString(),
                };
            }
            if (scopeIncludesEmail) {
                // Include the user's email address
                idTokenPayload = {
                    ...idTokenPayload,
                    email: user.getUser().email,
                    // TODO: Add verification system
                    email_verified: true,
                };
            }
        }

        const idToken = await new SignJWT(idTokenPayload)
            .setProtectedHeader({
                alg: "EdDSA",
            })
            .sign(privateKey);

        await db.insert(Tokens).values({
            accessToken: randomBytes(64).toString("base64url"),
            code: code,
            scope: scope ?? application.scopes,
            tokenType: TokenType.BEARER,
            applicationId: application.id,
            redirectUri: redirect_uri ?? application.redirectUri,
            expiresAt: new Date(Date.now() + 60 * 60 * 24 * 14).toISOString(),
            idToken:
                scopeIncludesOpenID ||
                scopeIncludesEmail ||
                scopeIncludesProfile
                    ? idToken
                    : null,
            clientId: client_id,
            userId: user.id,
        });

        // Redirect to the client
        const redirectUri = new URL(redirect_uri ?? application.redirectUri);

        const searchParams = new URLSearchParams({
            code: code,
        });

        return response(null, 302, {
            Location: `${redirectUri.origin}${
                redirectUri.pathname
            }?${searchParams.toString()}`,
            "Cache-Control": "no-store",
            Pragma: "no-cache",
        });
    },
);