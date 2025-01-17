import type { Hono } from "hono";
import type { RouterRoute } from "hono/types";
import type { z } from "zod";

export type HttpVerb = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS";
export interface APIRouteMetadata {
    allowedMethods: HttpVerb[];
    ratelimits: {
        max: number;
        duration: number;
    };
    route: string;
    auth: {
        required: boolean;
        requiredOnMethods?: HttpVerb[];
        oauthPermissions?: string[];
    };
}

export interface APIRouteExports {
    meta: APIRouteMetadata;
    schemas?: {
        query?: z.AnyZodObject;
        body?: z.AnyZodObject;
    };
    default: (app: Hono) => RouterRoute;
}
