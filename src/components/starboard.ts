import * as Discord from "discord.js";
import * as mongo from "mongodb";

import { strict as assert } from "assert";
import { unwrap } from "../utils/misc.js";
import { EMOJIREGEX, departialize } from "../utils/discord.js";
import { KeyedMutexSet } from "../utils/containers.js";
import { M } from "../utils/debugging-and-logging.js";
import { DAY, MINUTE } from "../common.js";
import { BotComponent } from "../bot-component.js";
import { CommandSetBuilder } from "../command-abstractions/command-set-builder.js";
import { Wheatley } from "../wheatley.js";
import { EarlyReplyMode, TextBasedCommandBuilder } from "../command-abstractions/text-based-command-builder.js";
import { TextBasedCommand } from "../command-abstractions/text-based-command.js";

const star_threshold = 5;
const other_threshold = 5;
const memes_star_threshold = 14;
const memes_other_threshold = 14;

const auto_delete_threshold = 5;

const max_deletes_in_24h = 7;

const starboard_epoch = new Date("2023-04-01T00:00:00.000Z").getTime();

// how long does a post have to reach the required reaction count
const starboard_window = 7 * DAY;

enum delete_trigger_type {
    delete_this,
    repost,
}

export default class Starboard extends BotComponent {
    mutex = new KeyedMutexSet<string>();

    deletes: number[] = [];

    // delete emojis: will trigger deletion if a threshold is reached relative to non-negative emojis
    // ignored emojis: these don't count towards the starboard
    // negative emojis: these don't count against deleted emojis and also don't go to the starboard
    // repost emojis: will trigger deletion if a threshold is reached relative to non-negative emojis

    delete_emojis: string[];
    ignored_emojis: string[];
    negative_emojis: string[];
    repost_emojis: string[];

    excluded_channels: Set<string>;

    override async setup(commands: CommandSetBuilder) {
        commands.add(
            new TextBasedCommandBuilder("add-negative-emoji", EarlyReplyMode.visible)
                .set_description("Register a negative emoji")
                .add_string_option({
                    title: "emojis",
                    description: "emojis",
                    required: true,
                })
                .set_permissions(Discord.PermissionFlagsBits.Administrator)
                .set_handler(this.add_negative_emoji.bind(this)),
        );

        commands.add(
            new TextBasedCommandBuilder("add-delete-emoji", EarlyReplyMode.visible)
                .set_description("Register a delete emoji")
                .add_string_option({
                    title: "emojis",
                    description: "emojis",
                    required: true,
                })
                .set_permissions(Discord.PermissionFlagsBits.Administrator)
                .set_handler(this.add_delete_emoji.bind(this)),
        );

        commands.add(
            new TextBasedCommandBuilder("add-ignored-emoji", EarlyReplyMode.visible)
                .set_description("Register an ignored emoji")
                .add_string_option({
                    title: "emojis",
                    description: "emojis",
                    required: true,
                })
                .set_permissions(Discord.PermissionFlagsBits.Administrator)
                .set_handler(this.add_ignored_emoji.bind(this)),
        );

        commands.add(
            new TextBasedCommandBuilder("add-repost-emoji", EarlyReplyMode.visible)
                .set_description("Register a repost emoji")
                .add_string_option({
                    title: "emojis",
                    description: "emojis",
                    required: true,
                })
                .set_permissions(Discord.PermissionFlagsBits.Administrator)
                .set_handler(this.add_repost_emoji.bind(this)),
        );

        commands.add(
            new TextBasedCommandBuilder("list-starboard-config", EarlyReplyMode.visible)
                .set_description("List starboard config")
                .set_permissions(Discord.PermissionFlagsBits.Administrator)
                .set_handler(this.list_config.bind(this)),
        );
    }

    override async on_ready() {
        this.excluded_channels = new Set([
            this.wheatley.channels.rules.id,
            this.wheatley.channels.announcements.id,
            this.wheatley.channels.server_suggestions.id,
            this.wheatley.channels.resources.id,
            this.wheatley.channels.the_button.id,
            this.wheatley.channels.introductions.id,
            this.wheatley.channels.starboard.id,
            this.wheatley.channels.goals2024.id,
            this.wheatley.channels.goals2025.id,
            this.wheatley.channels.skill_role_log.id,
            this.wheatley.channels.polls.id,
        ]);

        await this.get_emoji_config();
    }

    async get_emoji_config() {
        const singleton = await this.wheatley.database.get_bot_singleton();
        this.delete_emojis = singleton.starboard.delete_emojis;
        this.ignored_emojis = singleton.starboard.ignored_emojis;
        this.negative_emojis = singleton.starboard.negative_emojis;
        this.repost_emojis = singleton.starboard.repost_emojis;
    }

    reactions_string(message: Discord.Message) {
        return [
            ...message.reactions.cache
                .map(reaction => reaction)
                .filter(({ emoji }) => emoji instanceof Discord.GuildEmoji || emoji.id === null)
                .filter(({ emoji }) => !(emoji.name && this.ignored_emojis.includes(emoji.name)))
                .sort((a, b) => b.count - a.count)
                .map(
                    ({ emoji, count }) =>
                        `${
                            emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.name
                        } **${count}**`,
                ),
            `<#${message.channel.id}>`,
        ].join(" | ");
    }

    meets_threshold(reaction: Discord.MessageReaction) {
        assert(reaction.emoji.name);
        if (!(reaction.emoji instanceof Discord.GuildEmoji || reaction.emoji.id === null)) {
            return false;
        }
        if (reaction.emoji.name == "⭐") {
            if (reaction.message.channel.id == this.wheatley.channels.memes.id) {
                return reaction.count >= memes_star_threshold;
            } else {
                return reaction.count >= star_threshold;
            }
        } else if (
            !(this.negative_emojis.includes(reaction.emoji.name) || this.ignored_emojis.includes(reaction.emoji.name))
        ) {
            if (reaction.message.channel.id == this.wheatley.channels.memes.id) {
                return reaction.count >= memes_other_threshold;
            } else {
                return reaction.count >= other_threshold;
            }
        }
        return false;
    }

    async is_valid_channel(channel: Discord.GuildTextBasedChannel | Discord.TextBasedChannel) {
        return !this.excluded_channels.has(channel.id) && (await this.wheatley.is_public_channel(channel));
    }

    async update_starboard(message: Discord.Message) {
        await this.mutex.lock(message.id);
        try {
            const make_embeds = () =>
                this.utilities.make_quote_embeds([message], {
                    template: "\n\n**[Jump to message!]($$)**",
                });
            const starboard_entry = await this.wheatley.database.starboard_entries.findOne({ message: message.id });
            if (starboard_entry) {
                if (starboard_entry.deleted) {
                    return;
                }
                // edit
                let starboard_message;
                try {
                    starboard_message = await this.wheatley.channels.starboard.messages.fetch(
                        starboard_entry.starboard_entry,
                    );
                } catch (e: any) {
                    // unknown message
                    if (e instanceof Discord.DiscordAPIError && e.code === 10008) {
                        await this.wheatley.database.starboard_entries.updateOne(
                            {
                                message: message.id,
                            },
                            {
                                $set: {
                                    deleted: true,
                                },
                            },
                        );
                        return;
                    } else {
                        throw e;
                    }
                }
                await starboard_message.edit({
                    content: this.reactions_string(message),
                    ...(await make_embeds()),
                });
            } else {
                // send
                try {
                    const starboard_message = await this.wheatley.channels.starboard.send({
                        content: this.reactions_string(message),
                        ...(await make_embeds()),
                    });
                    await this.wheatley.database.starboard_entries.insertOne({
                        message: message.id,
                        starboard_entry: starboard_message.id,
                    });
                } catch (e) {
                    this.wheatley.critical_error(e);
                }
            }
        } finally {
            this.mutex.unlock(message.id);
        }
    }

    deletes_in_last_24h() {
        const last_24h = Date.now() - 60 * MINUTE * 24;
        this.deletes = this.deletes.filter(timestamp => timestamp >= last_24h);
        return this.deletes.length;
    }

    async handle_auto_delete(
        message: Discord.Message,
        trigger_reaction: Discord.MessageReaction,
        trigger_type: delete_trigger_type,
    ) {
        const reactions = message.reactions.cache.map(r => [r.emoji, r.count] as [Discord.Emoji, number]);
        const non_negative_reactions = reactions.filter(
            ([emoji, _]) =>
                !this.negative_emojis.includes(unwrap(emoji.name)) &&
                !this.delete_emojis.includes(unwrap(emoji.name)) &&
                !this.repost_emojis.includes(unwrap(emoji.name)),
        );
        const max_non_negative = Math.max(...non_negative_reactions.map(([_, count]) => count)); // -inf if |a|=0
        let do_delete = true;
        let no_delete_reason = null;
        if (![this.wheatley.channels.memes.id, this.wheatley.channels.cursed_code.id].includes(message.channel.id)) {
            do_delete = false;
            no_delete_reason = "not possible in this channel";
        }
        if (trigger_reaction.count <= max_non_negative) {
            do_delete = false;
            no_delete_reason = "greater or equal amount of non-negative reactions";
        }
        if (this.wheatley.is_root(message.author) || message.author.bot) {
            do_delete = false;
            no_delete_reason = "author is immune from deletions";
        }
        if (this.deletes_in_last_24h() >= max_deletes_in_24h) {
            do_delete = false;
            no_delete_reason = "24-hour age threshold exceeded";
            this.wheatley.info(">> DELETE IN 24H THRESHOLD EXCEEDED");
        }
        const action = do_delete ? "Auto-deleting" : `Auto-delete threshold reached, but no deletion (${no_delete_reason}) of`;
        M.log(`${action} ${message.url} for ${trigger_reaction.count} ${trigger_reaction.emoji.name} reactions`);
        let flag_message: Discord.Message | null = null;
        try {
            await this.wheatley.database.lock();
            if (
                do_delete ||
                !(await this.wheatley.database.auto_delete_threshold_notifications.findOne({ message: message.id }))
            ) {
                flag_message = await this.wheatley.channels.staff_flag_log.send({
                    content:
                        `${action} message from <@${message.author.id}> for ` +
                        `${trigger_reaction.count} ${trigger_reaction.emoji.name} reactions` +
                        `\n${this.reactions_string(message)}` +
                        "\n" +
                        (await trigger_reaction.users.fetch()).map(user => `<@${user.id}> ${user.tag}`).join("\n"),
                    ...(await this.utilities.make_quote_embeds([message])),
                    allowedMentions: { parse: [] },
                });
                // E11000 duplicate key error collection can happen here if somehow the key is inserted but the delete
                // doesn't happen. The bot restarting might be how this happens. Silently continue.
                await this.wheatley.database.auto_delete_threshold_notifications.insertOne({
                    message: message.id,
                });
            }
        } catch (e) {
            if (e instanceof mongo.MongoServerError && e.code == 11000) {
                // ok
            } else {
                do_delete = false;
                M.log("--------------->", message.url);
                this.wheatley.critical_error(e);
            }
        } finally {
            this.wheatley.database.unlock();
        }
        if (do_delete) {
            await this.wheatley.database.auto_deletes.insertOne({
                user: message.author.id,
                message_id: message.id,
                message_timestamp: message.createdTimestamp,
                delete_timestamp: Date.now(),
                flag_link: flag_message?.url,
            });
            await message.delete();
            assert(!(message.channel instanceof Discord.PartialGroupDMChannel));
            if (trigger_type == delete_trigger_type.delete_this) {
                if (message.channel.id == this.wheatley.channels.memes.id) {
                    await message.channel.send(
                        `<@${message.author.id}> A message of yours was automatically deleted because a threshold for` +
                            " <:delet_this:669598943117836312> reactions (or similar) was reached.\n\n" +
                            "FAQ: How can I avoid this in the future?\n" +
                            "Answer: Post less cringe",
                    );
                } else {
                    await message.channel.send(
                        `<@${message.author.id}> A message of yours was automatically deleted because a threshold for` +
                            " <:delet_this:669598943117836312> reactions (or similar) was reached.\n" +
                            "This was likely due to your post not actually being cursed code.",
                    );
                }
            } else {
                await message.channel.send(
                    `<@${message.author.id}> A message of yours was automatically deleted because a threshold for` +
                        " :recycle: reactions (or similar) was reached.",
                );
            }
            this.deletes.push(Date.now());
        }
    }

    // Check if the # of reactions is full, and there is no negative emojis reacted yet
    should_delete_reaction(reaction: Discord.MessageReaction) {
        return (
            reaction.message.channel.id === this.wheatley.channels.memes.id &&
            reaction.message.reactions.cache.size === 20 &&
            reaction.message.reactions.cache.filter(
                reaction =>
                    reaction.emoji.name &&
                    (this.repost_emojis.includes(reaction.emoji.name) ||
                        this.delete_emojis.includes(reaction.emoji.name) ||
                        this.negative_emojis.includes(reaction.emoji.name)),
            ).size === 0
        );
    }
    override async on_reaction_add(reaction: Discord.MessageReaction | Discord.PartialMessageReaction) {
        if (!(await this.is_valid_channel(reaction.message.channel))) {
            return;
        }
        if (reaction.partial) {
            reaction = await reaction.fetch();
        }

        if (this.should_delete_reaction(reaction)) {
            const last_reaction = reaction.message.reactions.cache.last();
            await last_reaction?.remove();
        }
        // Check delete emojis
        if (
            reaction.emoji.name &&
            this.delete_emojis.includes(reaction.emoji.name) &&
            reaction.count >= auto_delete_threshold
        ) {
            await this.handle_auto_delete(
                await departialize(reaction.message),
                reaction,
                delete_trigger_type.delete_this,
            );
            return;
        }
        if (
            reaction.emoji.name &&
            this.repost_emojis.includes(reaction.emoji.name) &&
            reaction.count >= auto_delete_threshold
        ) {
            await this.handle_auto_delete(await departialize(reaction.message), reaction, delete_trigger_type.repost);
            return;
        }

        // Update/add to starboard
        if (await this.wheatley.database.starboard_entries.findOne({ message: reaction.message.id })) {
            // Update counts
            await this.update_starboard(await departialize(reaction.message));
            return;
        }
        if (
            this.meets_threshold(await departialize(reaction)) &&
            reaction.message.createdTimestamp >= starboard_epoch &&
            reaction.message.createdTimestamp >= Date.now() - starboard_window
        ) {
            // Send
            await this.update_starboard(await departialize(reaction.message));
        }
    }

    override async on_reaction_remove(reaction: Discord.MessageReaction | Discord.PartialMessageReaction) {
        if (!(await this.is_valid_channel(reaction.message.channel))) {
            return;
        }
        if (await this.wheatley.database.starboard_entries.findOne({ message: reaction.message.id })) {
            // Update counts
            await this.update_starboard(await departialize(reaction.message));
        }
    }

    override async on_message_update(
        old_message: Discord.Message | Discord.PartialMessage,
        new_message: Discord.Message | Discord.PartialMessage,
    ) {
        if (!(await this.is_valid_channel(new_message.channel))) {
            return;
        }
        assert(old_message.id == new_message.id);
        if (await this.wheatley.database.starboard_entries.findOne({ message: old_message.id })) {
            // Update content
            await this.update_starboard(await departialize(new_message));
        }
    }

    override async on_message_delete(message: Discord.Message | Discord.PartialMessage) {
        const entry = await this.wheatley.database.starboard_entries.findOne({ message: message.id });
        if (entry) {
            await this.mutex.lock(message.id);
            try {
                await this.wheatley.channels.starboard.messages.delete(entry.starboard_entry);
                await this.wheatley.database.starboard_entries.deleteOne({ message: message.id });
            } finally {
                this.mutex.unlock(message.id);
            }
        }
    }

    //
    // Starboard config commands
    //

    async add_negative_emoji(command: TextBasedCommand, arg: string) {
        const emojis = arg.match(EMOJIREGEX);
        if (emojis) {
            const names = emojis.map(emoji => (emoji.startsWith("<") ? emoji.split(":")[1] : emoji));
            await this.wheatley.database.wheatley.updateOne(
                { id: "main" },
                {
                    $push: {
                        "starboard.negative_emojis": {
                            $each: names.filter(name => !this.negative_emojis.includes(name)),
                        },
                    },
                },
            );
            await this.get_emoji_config();
            await command.reply(`Added ${names.join(", ")} to the negative emojis`);
        } else {
            await command.reply("No emojis found");
        }
    }

    async add_delete_emoji(command: TextBasedCommand, arg: string) {
        const emojis = arg.match(EMOJIREGEX);
        if (emojis) {
            const names = emojis.map(emoji => (emoji.startsWith("<") ? emoji.split(":")[1] : emoji));
            await this.wheatley.database.wheatley.updateOne(
                { id: "main" },
                {
                    $push: {
                        "starboard.delete_emojis": {
                            $each: names.filter(name => !this.delete_emojis.includes(name)),
                        },
                    },
                },
            );
            await this.get_emoji_config();
            await command.reply(`Added ${names.join(", ")} to the delete emojis`);
        } else {
            await command.reply("No emojis found");
        }
    }

    async add_ignored_emoji(command: TextBasedCommand, arg: string) {
        const emojis = arg.match(EMOJIREGEX);
        if (emojis) {
            const names = emojis.map(emoji => (emoji.startsWith("<") ? emoji.split(":")[1] : emoji));
            await this.wheatley.database.wheatley.updateOne(
                { id: "main" },
                {
                    $push: {
                        "starboard.ignored_emojis": {
                            $each: names.filter(name => !this.ignored_emojis.includes(name)),
                        },
                    },
                },
            );
            await this.get_emoji_config();
            await command.reply(`Added ${names.join(", ")} to the ignored emojis`);
        } else {
            await command.reply("No emojis found");
        }
    }

    async add_repost_emoji(command: TextBasedCommand, arg: string) {
        const emojis = arg.match(EMOJIREGEX);
        if (emojis) {
            const names = emojis.map(emoji => (emoji.startsWith("<") ? emoji.split(":")[1] : emoji));
            await this.wheatley.database.wheatley.updateOne(
                { id: "main" },
                {
                    $push: {
                        "starboard.repost_emojis": {
                            $each: names.filter(name => !this.repost_emojis.includes(name)),
                        },
                    },
                },
            );
            await this.get_emoji_config();
            await command.reply(`Added ${names.join(", ")} to the ignored emojis`);
        } else {
            await command.reply("No emojis found");
        }
    }

    async list_config(command: TextBasedCommand) {
        await command.reply(
            [
                `Negative emojis: ${this.negative_emojis.join(", ")}`,
                `Delete emojis: ${this.delete_emojis.join(", ")}`,
                `Ignored emojis: ${this.ignored_emojis.join(", ")}`,
                `Repost emojis: ${this.repost_emojis.join(", ")}`,
            ].join("\n"),
        );
    }
}
