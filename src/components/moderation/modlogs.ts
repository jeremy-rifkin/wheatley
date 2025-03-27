import { strict as assert } from "assert";

import * as Discord from "discord.js";
import * as mongo from "mongodb";

import { build_description, truncate } from "../../utils/strings.js";
import { pluralize, time_to_human } from "../../utils/strings.js";
import { M } from "../../utils/debugging-and-logging.js";
import { BotComponent } from "../../bot-component.js";
import { CommandSetBuilder } from "../../command-abstractions/command-set-builder.js";
import { Wheatley } from "../../wheatley.js";
import { colors } from "../../common.js";
import { EarlyReplyMode, TextBasedCommandBuilder } from "../../command-abstractions/text-based-command-builder.js";
import { CommandAbstractionReplyOptions, TextBasedCommand } from "../../command-abstractions/text-based-command.js";
import { remove } from "../../utils/arrays.js";
import { moderation_edit_info, moderation_entry } from "../../infra/schemata/moderation.js";
import { discord_timestamp } from "../../utils/discord.js";

const moderations_per_page = 5;

function was_removed_early(timestamp: number, issued_at: number, duration: number) {
    return timestamp < issued_at + duration;
}

export default class Modlogs extends BotComponent {
    override async setup(commands: CommandSetBuilder) {
        commands.add(
            new TextBasedCommandBuilder("modlogs", EarlyReplyMode.visible)
                .set_description("Get user moderation logs")
                .set_permissions(Discord.PermissionFlagsBits.BanMembers)
                .add_user_option({
                    title: "user",
                    description: "User to get modlogs for",
                    required: true,
                })
                .set_handler(this.modlogs.bind(this)),
        );

        commands.add(
            new TextBasedCommandBuilder("case", EarlyReplyMode.visible)
                .set_description("Get case info")
                .set_permissions(Discord.PermissionFlagsBits.BanMembers)
                .add_number_option({
                    title: "case",
                    description: "Case to get information for",
                    required: true,
                })
                .set_handler(this.case_info.bind(this)),
        );
    }

    static moderation_description(moderation: moderation_entry, is_field: boolean, show_private_logs: boolean) {
        // 256 chosen as an ideally generous padding to allow the preceding text before the reason to fit
        const max_reason = (is_field ? 1024 : 4096) - 256;
        const description = build_description(
            `**Type:** ${moderation.type}`,
            moderation.type === "rolepersist" ? `**Role:** <@&${moderation.role}>` : null,
            show_private_logs ? `**Moderator:** <@${moderation.moderator}>` : null,
            `**Issued At:** ${discord_timestamp(moderation.issued_at)} ${
                moderation.link ? `[link](${moderation.link})` : ""
            }`,
            moderation.duration === null ? null : `**Duration:** ${time_to_human(moderation.duration)}`,
            `**Reason:** ${moderation.reason ? truncate(moderation.reason, max_reason) : "No reason provided"}`,
            moderation.removed &&
                (!moderation.duration ||
                    was_removed_early(moderation.removed.timestamp, moderation.issued_at, moderation.duration))
                ? `**Removed:** ${discord_timestamp(moderation.removed.timestamp)}` +
                      (show_private_logs ? ` by <@${moderation.removed.moderator}>` : "") +
                      ` with reason: "${moderation.removed.reason ? truncate(moderation.removed.reason, 100) : "None"}"`
                : null,
            moderation.context && show_private_logs ? `**Context:** ${moderation.context.join(", ")}` : null,
        );
        return moderation.expunged ? `~~${description}~~` : description;
    }

    static case_summary(moderation: moderation_entry, user: Discord.User, show_private_logs: boolean) {
        return new Discord.EmbedBuilder()
            .setTitle(`Case ${moderation.case_number}`)
            .setAuthor(
                show_private_logs
                    ? {
                          name: moderation.user_name,
                          iconURL: user.avatarURL() ?? undefined,
                      }
                    : null,
            )
            .setColor(colors.wheatley)
            .setDescription(Modlogs.moderation_description(moderation, false, show_private_logs))
            .setFields(
                remove(
                    [
                        moderation.removed
                            ? {
                                  name: "Removed",
                                  value: truncate(
                                      build_description(
                                          show_private_logs ? `**By:** <@${moderation.removed.moderator}>` : null,
                                          `**At:** ${discord_timestamp(moderation.removed.timestamp)}`,
                                          `**Reason:** ${
                                              moderation.removed.reason
                                                  ? moderation.removed.reason
                                                  : "No reason provided"
                                          }`,
                                      ),
                                      1024,
                                  ),
                              }
                            : null,
                        moderation.expunged
                            ? {
                                  name: "Expunged",
                                  value: truncate(
                                      build_description(
                                          show_private_logs ? `**By:** <@${moderation.expunged.moderator}>` : null,
                                          `**At:** ${discord_timestamp(moderation.expunged.timestamp)}`,
                                          `**Reason:** ${
                                              moderation.expunged.reason
                                                  ? moderation.expunged.reason
                                                  : "No reason provided"
                                          }`,
                                      ),
                                      1024,
                                  ),
                              }
                            : null,
                    ],
                    null,
                ),
            )
            .setFooter(
                show_private_logs
                    ? {
                          text: `ID: ${moderation.user}`,
                      }
                    : null,
            );
    }

    // page is zero-indexed
    async modlogs_message(
        user: Discord.User,
        page: number,
        show_private_logs = false,
    ): Promise<Discord.BaseMessageOptions & CommandAbstractionReplyOptions> {
        // TODO: Expunged or irrelevant? Show how things were removed / why?
        const query: mongo.Filter<moderation_entry> = { user: user.id, expunged: null };
        if (!show_private_logs) {
            query.type = { $ne: "note" };
        }
        const moderations = await this.wheatley.database.moderations.find(query).sort({ issued_at: -1 }).toArray();
        const pages = Math.ceil(moderations.length / moderations_per_page);
        const buttons: Discord.ButtonBuilder[] = [];
        if (pages <= 1) {
            // pass
        } else if (pages == 2) {
            buttons.push(
                new Discord.ButtonBuilder()
                    .setCustomId(`modlogs_page_${user.id}_${(page + 1) % pages}`)
                    .setLabel(page == 0 ? "🡆" : "🡄")
                    .setStyle(Discord.ButtonStyle.Primary),
            );
        } else {
            buttons.push(
                new Discord.ButtonBuilder()
                    // a custom id can be up to 100 characters long
                    .setCustomId(`modlogs_page_${user.id}_${page === 0 ? pages - 1 : page - 1}`)
                    .setLabel("🡄")
                    .setStyle(Discord.ButtonStyle.Primary),
                new Discord.ButtonBuilder()
                    .setCustomId(`modlogs_page_${user.id}_${(page + 1) % pages}`)
                    .setLabel("🡆")
                    .setStyle(Discord.ButtonStyle.Primary),
            );
        }
        return {
            embeds: [
                new Discord.EmbedBuilder()
                    .setTitle(`Modlogs for ${user.displayName} (page ${page + 1} of ${pages})`)
                    .setColor(colors.wheatley)
                    .setDescription(`<@${user.id}>`)
                    .setFields(
                        moderations
                            .slice(page * moderations_per_page, (page + 1) * moderations_per_page)
                            .map(moderation => {
                                return {
                                    name: `Case ${moderation.case_number}`,
                                    value: Modlogs.moderation_description(moderation, true, show_private_logs),
                                };
                            }),
                    )
                    .setFooter({
                        text: `${pluralize(moderations.length, "log")}, ${pluralize(pages, "page")} | ID: ${user.id}`,
                    }),
            ],
            components:
                buttons.length == 0
                    ? undefined
                    : [
                          new Discord.ActionRowBuilder<Discord.MessageActionRowComponentBuilder>().addComponents(
                              ...buttons,
                          ),
                      ],
        };
    }

    is_mod_only(channel: Discord.GuildTextBasedChannel | Discord.TextBasedChannel) {
        if (channel.isDMBased() || !channel.parent) {
            return false;
        }
        return [this.wheatley.categories.staff.id, this.wheatley.categories.staff_logs.id].includes(channel.parent.id);
    }

    async modlogs(command: TextBasedCommand, user: Discord.User) {
        await command.reply(await this.modlogs_message(user, 0, this.is_mod_only(await command.get_channel())));
    }

    override async on_interaction_create(interaction: Discord.Interaction<Discord.CacheType>) {
        if (interaction.isButton()) {
            if (interaction.customId.startsWith("modlogs_page_")) {
                if (!this.wheatley.is_authorized_mod(interaction.user)) {
                    await interaction.reply({
                        content: "Error: You are not authorized",
                        ephemeral: true,
                    });
                    return;
                }
                const [user, page] = interaction.customId.substring("modlogs_page_".length).split("_");
                await interaction.message.edit(
                    await this.modlogs_message(await this.wheatley.client.users.fetch(user), parseInt(page)),
                );
                await interaction.deferUpdate();
            }
        }
    }

    async case_info(command: TextBasedCommand, case_number: number) {
        const moderation = await this.wheatley.database.moderations.findOne({ case_number });
        if (moderation) {
            await command.reply({
                embeds: [
                    Modlogs.case_summary(
                        moderation,
                        await this.wheatley.client.users.fetch(moderation.user),
                        this.is_mod_only(await command.get_channel()),
                    ),
                ],
            });
        } else {
            await this.reply_with_error(command, `Case ${case_number} not found`);
        }
    }

    // TODO: Code duplication
    async reply_with_error(command: TextBasedCommand, message: string) {
        await command.replyOrFollowUp({
            embeds: [
                new Discord.EmbedBuilder()
                    .setColor(colors.alert_color)
                    .setDescription(`${this.wheatley.error} ***${message}***`),
            ],
        });
    }
}
