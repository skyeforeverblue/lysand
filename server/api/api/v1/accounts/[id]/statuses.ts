import { errorResponse, jsonResponse } from "@response";
import { MatchedRoute } from "bun";
import { Status } from "~database/entities/Status";
import { User } from "~database/entities/User";

/**
 * Fetch all statuses for a user
 */
export default async (
	req: Request,
	matchedRoute: MatchedRoute
): Promise<Response> => {
	const id = matchedRoute.params.id;

	const {
		limit,
		exclude_reblogs,
	}: {
		max_id?: string;
		since_id?: string;
		min_id?: string;
		limit?: number;
		only_media?: boolean;
		exclude_replies?: boolean;
		exclude_reblogs?: boolean;
		pinned?: boolean;
		tagged?: string;
	} = matchedRoute.query;

	const user = await User.findOneBy({
		id,
	});

	if (!user) return errorResponse("User not found", 404);

	// TODO: Check if status can be seen by this user
	const statuses = await Status.find({
		where: {
			account: {
				id: user.id,
			},
			isReblog: exclude_reblogs ? true : undefined,
		},
		relations: ["account", "emojis", "announces", "likes", "object"],
		order: {
			created_at: "DESC",
		},
		take: limit ?? 20,
	});

	return jsonResponse(
		await Promise.all(statuses.map(async status => await status.toAPI()))
	);
};