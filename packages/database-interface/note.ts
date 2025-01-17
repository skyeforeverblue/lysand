import { idValidator } from "@/api";
import { dualLogger } from "@/loggers";
import { proxyUrl } from "@/response";
import { sanitizedHtmlStrip } from "@/sanitization";
import type { EntityValidator } from "@lysand-org/federation";
import {
    type InferInsertModel,
    type SQL,
    and,
    count,
    desc,
    eq,
    inArray,
    isNotNull,
    sql,
} from "drizzle-orm";
import { htmlToText } from "html-to-text";
import { LogLevel } from "log-manager";
import { createRegExp, exactly, global } from "magic-regexp";
import {
    type Application,
    applicationToAPI,
} from "~/database/entities/Application";
import {
    attachmentFromLysand,
    attachmentToAPI,
    attachmentToLysand,
} from "~/database/entities/Attachment";
import {
    type EmojiWithInstance,
    emojiToAPI,
    emojiToLysand,
    fetchEmoji,
    parseEmojis,
} from "~/database/entities/Emoji";
import { localObjectURI } from "~/database/entities/Federation";
import {
    type Status,
    type StatusWithRelations,
    contentToHtml,
    findManyNotes,
} from "~/database/entities/Status";
import { db } from "~/drizzle/db";
import {
    Attachments,
    EmojiToNote,
    NoteToMentions,
    Notes,
    Notifications,
    Users,
} from "~/drizzle/schema";
import { config } from "~/packages/config-manager";
import type { Attachment as APIAttachment } from "~/types/mastodon/attachment";
import type { Status as APIStatus } from "~/types/mastodon/status";
import { User } from "./user";

/**
 * Gives helpers to fetch notes from database in a nice format
 */
export class Note {
    private constructor(private status: StatusWithRelations) {}

    static async fromId(
        id: string | null,
        userId?: string,
    ): Promise<Note | null> {
        if (!id) return null;

        return await Note.fromSql(eq(Notes.id, id), undefined, userId);
    }

    static async fromIds(ids: string[], userId?: string): Promise<Note[]> {
        return await Note.manyFromSql(
            inArray(Notes.id, ids),
            undefined,
            undefined,
            undefined,
            userId,
        );
    }

    static async fromSql(
        sql: SQL<unknown> | undefined,
        orderBy: SQL<unknown> | undefined = desc(Notes.id),
        userId?: string,
    ) {
        const found = await findManyNotes(
            {
                where: sql,
                orderBy,
                limit: 1,
            },
            userId,
        );

        if (!found[0]) return null;
        return new Note(found[0]);
    }

    static async manyFromSql(
        sql: SQL<unknown> | undefined,
        orderBy: SQL<unknown> | undefined = desc(Notes.id),
        limit?: number,
        offset?: number,
        userId?: string,
    ) {
        const found = await findManyNotes(
            {
                where: sql,
                orderBy,
                limit,
                offset,
            },
            userId,
        );

        return found.map((s) => new Note(s));
    }

    get id() {
        return this.status.id;
    }

    async getUsersToFederateTo() {
        // Mentioned users
        const mentionedUsers =
            this.getStatus().mentions.length > 0
                ? await User.manyFromSql(
                      and(
                          isNotNull(Users.instanceId),
                          inArray(
                              Users.id,
                              this.getStatus().mentions.map(
                                  (mention) => mention.id,
                              ),
                          ),
                      ),
                  )
                : [];

        const usersThatCanSeePost = await User.manyFromSql(
            isNotNull(Users.instanceId),
            undefined,
            undefined,
            undefined,
            {
                with: {
                    relationships: {
                        where: (relationship, { eq, and }) =>
                            and(
                                eq(relationship.subjectId, Users.id),
                                eq(relationship.following, true),
                            ),
                    },
                },
            },
        );

        const fusedUsers = [...mentionedUsers, ...usersThatCanSeePost];

        const deduplicatedUsersById = fusedUsers.filter(
            (user, index, self) =>
                index === self.findIndex((t) => t.id === user.id),
        );

        return deduplicatedUsersById;
    }

    static fromStatus(status: StatusWithRelations) {
        return new Note(status);
    }

    static fromStatuses(statuses: StatusWithRelations[]) {
        return statuses.map((s) => new Note(s));
    }

    isNull() {
        return this.status === null;
    }

    getStatus() {
        return this.status;
    }

    getAuthor() {
        return new User(this.status.author);
    }

    static async getCount() {
        return (
            await db
                .select({
                    count: count(),
                })
                .from(Notes)
                .where(
                    sql`EXISTS (SELECT 1 FROM "Users" WHERE "Users"."id" = ${Notes.authorId} AND "Users"."instanceId" IS NULL)`,
                )
        )[0].count;
    }

    async getReplyChildren(userId?: string) {
        return await Note.manyFromSql(
            eq(Notes.replyId, this.status.id),
            undefined,
            undefined,
            undefined,
            userId,
        );
    }

    static async insert(values: InferInsertModel<typeof Notes>) {
        return (await db.insert(Notes).values(values).returning())[0];
    }

    async isRemote() {
        return this.getAuthor().isRemote();
    }

    async updateFromRemote() {
        if (!this.isRemote()) {
            throw new Error("Cannot refetch a local note (it is not remote)");
        }

        const updated = await Note.saveFromRemote(this.getURI());

        if (!updated) {
            throw new Error("Note not found after update");
        }

        this.status = updated.getStatus();

        return this;
    }

    static async fromData(
        author: User,
        content: typeof EntityValidator.$ContentFormat,
        visibility: APIStatus["visibility"],
        is_sensitive: boolean,
        spoiler_text: string,
        emojis: EmojiWithInstance[],
        uri?: string,
        mentions?: User[],
        /** List of IDs of database Attachment objects */
        media_attachments?: string[],
        replyId?: string,
        quoteId?: string,
        application?: Application,
    ): Promise<Note | null> {
        const htmlContent = await contentToHtml(content, mentions);

        // Parse emojis and fuse with existing emojis
        let foundEmojis = emojis;

        if (author.isLocal()) {
            const parsedEmojis = await parseEmojis(htmlContent);
            // Fuse and deduplicate
            foundEmojis = [...emojis, ...parsedEmojis].filter(
                (emoji, index, self) =>
                    index === self.findIndex((t) => t.id === emoji.id),
            );
        }

        const newNote = await Note.insert({
            authorId: author.id,
            content: htmlContent,
            contentSource:
                content["text/plain"]?.content ||
                content["text/markdown"]?.content ||
                Object.entries(content)[0][1].content ||
                "",
            contentType: "text/html",
            visibility,
            sensitive: is_sensitive,
            spoilerText: await sanitizedHtmlStrip(spoiler_text),
            uri: uri || null,
            replyId: replyId ?? null,
            quotingId: quoteId ?? null,
            applicationId: application?.id ?? null,
        });

        // Connect emojis
        for (const emoji of foundEmojis) {
            await db
                .insert(EmojiToNote)
                .values({
                    emojiId: emoji.id,
                    noteId: newNote.id,
                })
                .execute();
        }

        // Connect mentions
        for (const mention of mentions ?? []) {
            await db
                .insert(NoteToMentions)
                .values({
                    noteId: newNote.id,
                    userId: mention.id,
                })
                .execute();
        }

        // Set attachment parents
        if (media_attachments && media_attachments.length > 0) {
            await db
                .update(Attachments)
                .set({
                    noteId: newNote.id,
                })
                .where(inArray(Attachments.id, media_attachments));
        }

        // Send notifications for mentioned local users
        for (const mention of mentions ?? []) {
            if (mention.isLocal()) {
                await db.insert(Notifications).values({
                    accountId: author.id,
                    notifiedId: mention.id,
                    type: "mention",
                    noteId: newNote.id,
                });
            }
        }

        return await Note.fromId(newNote.id, newNote.authorId);
    }

    async updateFromData(
        content?: typeof EntityValidator.$ContentFormat,
        visibility?: APIStatus["visibility"],
        is_sensitive?: boolean,
        spoiler_text?: string,
        emojis: EmojiWithInstance[] = [],
        mentions: User[] = [],
        /** List of IDs of database Attachment objects */
        media_attachments: string[] = [],
        replyId?: string,
        quoteId?: string,
        application?: Application,
    ) {
        const htmlContent = content
            ? await contentToHtml(content, mentions)
            : undefined;

        // Parse emojis and fuse with existing emojis
        let foundEmojis = emojis;

        if (this.getAuthor().isLocal() && htmlContent) {
            const parsedEmojis = await parseEmojis(htmlContent);
            // Fuse and deduplicate
            foundEmojis = [...emojis, ...parsedEmojis].filter(
                (emoji, index, self) =>
                    index === self.findIndex((t) => t.id === emoji.id),
            );
        }

        const newNote = await this.update({
            content: htmlContent,
            contentSource: content
                ? content["text/plain"]?.content ||
                  content["text/markdown"]?.content ||
                  Object.entries(content)[0][1].content ||
                  ""
                : undefined,
            contentType: "text/html",
            visibility,
            sensitive: is_sensitive,
            spoilerText: spoiler_text,
            replyId,
            quotingId: quoteId,
            applicationId: application?.id,
        });

        // Connect emojis
        await db
            .delete(EmojiToNote)
            .where(eq(EmojiToNote.noteId, this.status.id));

        for (const emoji of foundEmojis) {
            await db
                .insert(EmojiToNote)
                .values({
                    emojiId: emoji.id,
                    noteId: this.status.id,
                })
                .execute();
        }

        // Connect mentions
        await db
            .delete(NoteToMentions)
            .where(eq(NoteToMentions.noteId, this.status.id));

        for (const mention of mentions ?? []) {
            await db
                .insert(NoteToMentions)
                .values({
                    noteId: this.status.id,
                    userId: mention.id,
                })
                .execute();
        }

        // Set attachment parents
        if (media_attachments) {
            await db
                .update(Attachments)
                .set({
                    noteId: null,
                })
                .where(eq(Attachments.noteId, this.status.id));

            if (media_attachments.length > 0)
                await db
                    .update(Attachments)
                    .set({
                        noteId: this.status.id,
                    })
                    .where(inArray(Attachments.id, media_attachments));
        }

        return await Note.fromId(newNote.id, newNote.authorId);
    }

    static async resolve(
        uri?: string,
        providedNote?: typeof EntityValidator.$Note,
    ): Promise<Note | null> {
        // Check if note not already in database
        const foundNote = uri && (await Note.fromSql(eq(Notes.uri, uri)));

        if (foundNote) return foundNote;

        // Check if URI is of a local note
        if (uri?.startsWith(config.http.base_url)) {
            const uuid = uri.match(idValidator);

            if (!uuid || !uuid[0]) {
                throw new Error(
                    `URI ${uri} is of a local note, but it could not be parsed`,
                );
            }

            return await Note.fromId(uuid[0]);
        }

        return await Note.saveFromRemote(uri, providedNote);
    }

    static async saveFromRemote(
        uri?: string,
        providedNote?: typeof EntityValidator.$Note,
    ): Promise<Note | null> {
        if (!uri && !providedNote) {
            throw new Error("No URI or note provided");
        }

        const foundStatus = await Note.fromSql(
            eq(Notes.uri, uri ?? providedNote?.uri ?? ""),
        );

        let note = providedNote || null;

        if (uri) {
            if (!URL.canParse(uri)) {
                throw new Error(`Invalid URI to parse ${uri}`);
            }

            const response = await fetch(uri, {
                method: "GET",
                headers: {
                    Accept: "application/json",
                },
            });

            note = (await response.json()) as typeof EntityValidator.$Note;
        }

        if (!note) {
            throw new Error("No note was able to be fetched");
        }

        if (note.type !== "Note") {
            throw new Error("Invalid object type");
        }

        if (!note.author) {
            throw new Error("Invalid object author");
        }

        const author = await User.resolve(note.author);

        if (!author) {
            throw new Error("Invalid object author");
        }

        const attachments = [];

        for (const attachment of note.attachments ?? []) {
            const resolvedAttachment = await attachmentFromLysand(
                attachment,
            ).catch((e) => {
                dualLogger.logError(
                    LogLevel.ERROR,
                    "Federation.StatusResolver",
                    e,
                );
                return null;
            });

            if (resolvedAttachment) {
                attachments.push(resolvedAttachment);
            }
        }

        const emojis = [];

        for (const emoji of note.extensions?.["org.lysand:custom_emojis"]
            ?.emojis ?? []) {
            const resolvedEmoji = await fetchEmoji(emoji).catch((e) => {
                dualLogger.logError(
                    LogLevel.ERROR,
                    "Federation.StatusResolver",
                    e,
                );
                return null;
            });

            if (resolvedEmoji) {
                emojis.push(resolvedEmoji);
            }
        }

        if (foundStatus) {
            return await foundStatus.updateFromData(
                note.content ?? {
                    "text/plain": {
                        content: "",
                    },
                },
                note.visibility as APIStatus["visibility"],
                note.is_sensitive ?? false,
                note.subject ?? "",
                emojis,
                note.mentions
                    ? await Promise.all(
                          (note.mentions ?? [])
                              .map((mention) => User.resolve(mention))
                              .filter(
                                  (mention) => mention !== null,
                              ) as Promise<User>[],
                      )
                    : [],
                attachments.map((a) => a.id),
                note.replies_to
                    ? (await Note.resolve(note.replies_to))?.getStatus().id
                    : undefined,
                note.quotes
                    ? (await Note.resolve(note.quotes))?.getStatus().id
                    : undefined,
            );
        }

        const createdNote = await Note.fromData(
            author,
            note.content ?? {
                "text/plain": {
                    content: "",
                },
            },
            note.visibility as APIStatus["visibility"],
            note.is_sensitive ?? false,
            note.subject ?? "",
            emojis,
            note.uri,
            await Promise.all(
                (note.mentions ?? [])
                    .map((mention) => User.resolve(mention))
                    .filter((mention) => mention !== null) as Promise<User>[],
            ),
            attachments.map((a) => a.id),
            note.replies_to
                ? (await Note.resolve(note.replies_to))?.getStatus().id
                : undefined,
            note.quotes
                ? (await Note.resolve(note.quotes))?.getStatus().id
                : undefined,
        );

        if (!createdNote) {
            throw new Error("Failed to create status");
        }

        return createdNote;
    }

    async delete() {
        return (
            await db
                .delete(Notes)
                .where(eq(Notes.id, this.status.id))
                .returning()
        )[0];
    }

    async update(newStatus: Partial<Status>) {
        return (
            await db
                .update(Notes)
                .set(newStatus)
                .where(eq(Notes.id, this.status.id))
                .returning()
        )[0];
    }

    static async deleteMany(ids: string[]) {
        return await db.delete(Notes).where(inArray(Notes.id, ids)).returning();
    }

    /**
     * Returns whether this status is viewable by a user.
     * @param user The user to check.
     * @returns Whether this status is viewable by the user.
     */
    async isViewableByUser(user: User | null) {
        if (this.getAuthor().id === user?.id) return true;
        if (this.getStatus().visibility === "public") return true;
        if (this.getStatus().visibility === "unlisted") return true;
        if (this.getStatus().visibility === "private") {
            return user
                ? await db.query.Relationships.findFirst({
                      where: (relationship, { and, eq }) =>
                          and(
                              eq(relationship.ownerId, user?.id),
                              eq(relationship.subjectId, Notes.authorId),
                              eq(relationship.following, true),
                          ),
                  })
                : false;
        }
        return (
            user &&
            this.getStatus().mentions.find((mention) => mention.id === user.id)
        );
    }

    async toAPI(userFetching?: User | null): Promise<APIStatus> {
        const data = this.getStatus();

        // Convert mentions of local users from @username@host to @username
        const mentionedLocalUsers = data.mentions.filter(
            (mention) => mention.instanceId === null,
        );

        // Rewrite all src tags to go through proxy
        let replacedContent = new HTMLRewriter()
            .on("[src]", {
                element(element) {
                    element.setAttribute(
                        "src",
                        proxyUrl(element.getAttribute("src") ?? "") ?? "",
                    );
                },
            })
            .transform(data.content);

        for (const mention of mentionedLocalUsers) {
            replacedContent = replacedContent.replace(
                createRegExp(
                    exactly(
                        `@${mention.username}@${
                            new URL(config.http.base_url).host
                        }`,
                    ),
                    [global],
                ),
                `@${mention.username}`,
            );
        }

        return {
            id: data.id,
            in_reply_to_id: data.replyId || null,
            in_reply_to_account_id: data.reply?.authorId || null,
            account: this.getAuthor().toAPI(userFetching?.id === data.authorId),
            created_at: new Date(data.createdAt).toISOString(),
            application: data.application
                ? applicationToAPI(data.application)
                : null,
            card: null,
            content: replacedContent,
            emojis: data.emojis.map((emoji) => emojiToAPI(emoji)),
            favourited: data.liked,
            favourites_count: data.likeCount,
            media_attachments: (data.attachments ?? []).map(
                (a) => attachmentToAPI(a) as APIAttachment,
            ),
            mentions: data.mentions.map((mention) => ({
                id: mention.id,
                acct: User.getAcct(
                    mention.instanceId === null,
                    mention.username,
                    mention.instance?.baseUrl,
                ),
                url: User.getUri(mention.id, mention.uri, config.http.base_url),
                username: mention.username,
            })),
            language: null,
            muted: data.muted,
            pinned: data.pinned,
            // TODO: Add polls
            poll: null,
            reblog: data.reblog
                ? await Note.fromStatus(
                      data.reblog as StatusWithRelations,
                  ).toAPI(userFetching)
                : null,
            reblogged: data.reblogged,
            reblogs_count: data.reblogCount,
            replies_count: data.replyCount,
            sensitive: data.sensitive,
            spoiler_text: data.spoilerText,
            tags: [],
            uri: data.uri || this.getMastoURI(),
            visibility: data.visibility as APIStatus["visibility"],
            url: data.uri || this.getMastoURI(),
            bookmarked: false,
            // @ts-expect-error Glitch-SOC extension
            quote: data.quotingId
                ? (await Note.fromId(data.quotingId, userFetching?.id).then(
                      (n) => n?.toAPI(userFetching),
                  )) ?? null
                : null,
            quote_id: data.quotingId || undefined,
        };
    }

    getURI() {
        return localObjectURI(this.getStatus().id);
    }

    static getURI(id?: string | null) {
        if (!id) return null;
        return localObjectURI(id);
    }

    getMastoURI() {
        return `/@${this.getAuthor().getUser().username}/${this.id}`;
    }

    toLysand(): typeof EntityValidator.$Note {
        const status = this.getStatus();
        return {
            type: "Note",
            created_at: new Date(status.createdAt).toISOString(),
            id: status.id,
            author: this.getAuthor().getUri(),
            uri: this.getURI(),
            content: {
                "text/html": {
                    content: status.content,
                },
                "text/plain": {
                    content: htmlToText(status.content),
                },
            },
            attachments: (status.attachments ?? []).map((attachment) =>
                attachmentToLysand(attachment),
            ),
            is_sensitive: status.sensitive,
            mentions: status.mentions.map((mention) => mention.uri || ""),
            quotes: Note.getURI(status.quotingId) ?? undefined,
            replies_to: Note.getURI(status.replyId) ?? undefined,
            subject: status.spoilerText,
            visibility: status.visibility as
                | "public"
                | "unlisted"
                | "private"
                | "direct",
            extensions: {
                "org.lysand:custom_emojis": {
                    emojis: status.emojis.map((emoji) => emojiToLysand(emoji)),
                },
                // TODO: Add polls and reactions
            },
        };
    }

    /**
     * Return all the ancestors of this post,
     */
    async getAncestors(fetcher: User | null) {
        const ancestors: Note[] = [];

        let currentStatus: Note = this;

        while (currentStatus.getStatus().replyId) {
            const parent = await Note.fromId(
                currentStatus.getStatus().replyId,
                fetcher?.id,
            );

            if (!parent) {
                break;
            }

            ancestors.push(parent);
            currentStatus = parent;
        }

        // Filter for posts that are viewable by the user
        const viewableAncestors = ancestors.filter((ancestor) =>
            ancestor.isViewableByUser(fetcher),
        );

        // Reverse the order so that the oldest posts are first
        return viewableAncestors.toReversed();
    }

    /**
     * Return all the descendants of this post (recursive)
     * Temporary implementation, will be replaced with a recursive SQL query when I get to it
     */
    async getDescendants(fetcher: User | null, depth = 0) {
        const descendants: Note[] = [];
        for (const child of await this.getReplyChildren(fetcher?.id)) {
            descendants.push(child);

            if (depth < 20) {
                const childDescendants = await child.getDescendants(
                    fetcher,
                    depth + 1,
                );
                descendants.push(...childDescendants);
            }
        }

        // Filter for posts that are viewable by the user

        const viewableDescendants = descendants.filter((descendant) =>
            descendant.isViewableByUser(fetcher),
        );

        return viewableDescendants;
    }
}
