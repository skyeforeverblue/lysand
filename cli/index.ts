import { execute } from "@oclif/core";
import EmojiAdd from "./commands/emoji/add";
import EmojiDelete from "./commands/emoji/delete";
import EmojiImport from "./commands/emoji/import";
import EmojiList from "./commands/emoji/list";
import Start from "./commands/start";
import UserCreate from "./commands/user/create";
import UserDelete from "./commands/user/delete";
import UserList from "./commands/user/list";
import UserRefetch from "./commands/user/refetch";
import UserReset from "./commands/user/reset";

// Use "explicit" oclif strategy to avoid issues with oclif's module resolver and bundling
export const commands = {
    "user:list": UserList,
    "user:delete": UserDelete,
    "user:create": UserCreate,
    "user:reset": UserReset,
    "user:refetch": UserRefetch,
    "emoji:add": EmojiAdd,
    "emoji:delete": EmojiDelete,
    "emoji:list": EmojiList,
    "emoji:import": EmojiImport,
    start: Start,
};

if (import.meta.path === Bun.main) {
    await execute({ dir: import.meta.url });
}
