import confirm from "@inquirer/confirm";
import { Flags } from "@oclif/core";
import chalk from "chalk";
import { UserFinderCommand } from "~/cli/classes";
import { formatArray } from "~/cli/utils/format";

export default class UserRefetch extends UserFinderCommand<typeof UserRefetch> {
    static override description = "Refetch remote users";

    static override examples = [
        "<%= config.bin %> <%= command.id %> johngastron --type username",
        "<%= config.bin %> <%= command.id %> 018ec11c-c6cb-7a67-bd20-a4c81bf42912",
    ];

    static override flags = {
        confirm: Flags.boolean({
            description:
                "Ask for confirmation before refetching the user (default yes)",
            allowNo: true,
            default: true,
        }),
        limit: Flags.integer({
            char: "n",
            description: "Limit the number of users",
            default: 1,
        }),
    };

    static override args = {
        identifier: UserFinderCommand.baseArgs.identifier,
    };

    public async run(): Promise<void> {
        const { flags } = await this.parse(UserRefetch);

        const users = await this.findUsers();

        if (!users || users.length === 0) {
            this.log(chalk.bold(`${chalk.red("✗")} No users found`));
            this.exit(1);
        }

        // Display user
        flags.print &&
            this.log(
                chalk.bold(
                    `${chalk.green("✓")} Found ${chalk.green(
                        users.length,
                    )} user(s)`,
                ),
            );

        flags.print &&
            this.log(
                formatArray(
                    users.map((u) => u.getUser()),
                    [
                        "id",
                        "username",
                        "displayName",
                        "createdAt",
                        "updatedAt",
                        "isAdmin",
                    ],
                ),
            );

        if (flags.confirm && !flags.print) {
            const choice = await confirm({
                message: `Refetch these users? ${chalk.red(
                    "This is irreversible.",
                )}`,
            });

            if (!choice) {
                this.log(chalk.bold(`${chalk.red("✗")} Aborted operation`));
                return this.exit(1);
            }
        }

        for (const user of users) {
            try {
                await user.updateFromRemote();
            } catch (error) {
                this.log(
                    chalk.bold(
                        `${chalk.red("✗")} Failed to refetch user ${
                            user.getUser().username
                        }`,
                    ),
                );
                this.log(chalk.red((error as Error).message));
            }
        }

        this.exit(0);
    }
}
