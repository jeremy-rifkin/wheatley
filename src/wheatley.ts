import { strict as assert } from "assert";
import * as Sentry from "@sentry/node";

import * as Discord from "discord.js";
import * as mongo from "mongodb";
import PromClient from "prom-client";

import { colors, MINUTE } from "./common.js";
import { unwrap } from "./utils/misc.js";
import { to_string, is_string } from "./utils/strings.js";
import { globIterate } from "glob";
import { M } from "./utils/debugging-and-logging.js";
import { BotComponent } from "./bot-component.js";

import { CommandAbstractionReplyOptions } from "./command-abstractions/text-based-command.js";

import { WheatleyDatabase, WheatleyDatabaseProxy } from "./infra/database-interface.js";
import { MemberTracker } from "./infra/member-tracker.js";
import { Virustotal } from "./infra/virustotal.js";
import { forge_snowflake, send_long_message } from "./utils/discord.js";
import { TypedEventEmitter } from "./utils/event-emitter.js";
import { setup_metrics_server } from "./infra/prometheus.js";
import { moderation_entry } from "./infra/schemata/moderation.js";
import { wheatley_database_info } from "./infra/schemata/wheatley.js";
import { LoggableChannel, LogLimiter } from "./infra/log-limiter.js";
import { CommandHandler } from "./command-handler.js";
import { CommandSetBuilder } from "./command-abstractions/command-set-builder.js";

export function create_basic_embed(title: string | undefined, color: number, content: string) {
    const embed = new Discord.EmbedBuilder().setColor(color).setDescription(content);
    if (title) {
        embed.setTitle(title);
    }
    return embed;
}

export function create_error_reply(message: string): Discord.BaseMessageOptions & CommandAbstractionReplyOptions {
    return {
        embeds: [create_basic_embed(undefined, colors.red, message)],
        should_text_reply: true,
    };
}

// Thu Jul 01 2021 00:00:00 GMT-0400 (Eastern Daylight Time)
export const SERVER_SUGGESTION_TRACKER_START_TIME = 1625112000000;

export type wheatley_database_credentials = {
    user: string;
    password: string;
    host?: string;
    port?: number;
};

export type wheatley_config = {
    id: string;
    guild: string;
    token: string;
    mom?: string;
    mongo?: wheatley_database_credentials;
    freestanding?: boolean;
    exclude?: string[];
    sentry?: string;
    virustotal?: string;
    metrics?: {
        port: number;
        hostname: string;
    };
};

const tuple = <T extends any[]>(...args: T): T => args;

const channels_map = {
    // staff
    staff_flag_log: tuple("1026972603019169842", Discord.TextChannel),
    staff_experimental_log: tuple("1207899185790197760", Discord.TextChannel),
    staff_action_log: tuple("845290775692443699", Discord.TextChannel),
    public_action_log: tuple("1341611685223596103", Discord.TextChannel),
    staff_clock_log: tuple("1220882759862452284", Discord.ForumChannel),
    welcome: tuple("778017793567490078", Discord.TextChannel),
    staff_member_log: tuple("875681819662622730", Discord.TextChannel),
    staff_message_log: tuple("467729928956411914", Discord.TextChannel),
    staff_only: tuple("342153262260289537", Discord.TextChannel),
    mods: tuple("847993258600038460", Discord.TextChannel),
    // meta
    rules: tuple("659868782877212723", Discord.TextChannel),
    announcements: tuple("331881381477089282", Discord.NewsChannel),
    server_suggestions: tuple("802541516655951892", Discord.TextChannel),
    skill_role_suggestions: tuple("1211089633547526204", Discord.ForumChannel),
    skill_roles_meta: tuple("1182536717056618557", Discord.TextChannel),
    news: tuple("1269506410530738267", Discord.ForumChannel),
    resources: tuple("1124619767542718524", Discord.ForumChannel),
    partners: tuple("904790565000986745", Discord.TextChannel),
    the_button: tuple("1069678919667687455", Discord.TextChannel),
    articles: tuple("1130174377539940475", Discord.TextChannel),
    // language channels
    cpp_help: tuple("1013107104678162544", Discord.ForumChannel),
    c_help: tuple("1013104018739974194", Discord.ForumChannel),
    cpp_help_text: tuple("331718580070645760", Discord.TextChannel),
    c_help_text: tuple("331718539738087426", Discord.TextChannel),
    c_cpp_discussion: tuple("851121440425639956", Discord.TextChannel),
    general_discussion: tuple("855220264149057556", Discord.TextChannel),
    code_review: tuple("1078717238678409369", Discord.ForumChannel),
    showcase: tuple("1014328785685979136", Discord.ForumChannel),
    tooling: tuple("331913460080181258", Discord.TextChannel),
    algorithms_and_compsci: tuple("857668280012242944", Discord.TextChannel),
    // off-topic
    starboard: tuple("800509841424252968", Discord.TextChannel),
    memes: tuple("526518219549442071", Discord.TextChannel),
    food: tuple("1288515484513468436", Discord.TextChannel),
    serious_off_topic: tuple("921113903574958080", Discord.TextChannel),
    room_of_requirement: tuple("1082800064113672192", Discord.TextChannel),
    boosters_only: tuple("792183875241639977", Discord.TextChannel),
    // other
    bot_spam: tuple("506274405500977153", Discord.TextChannel),
    introductions: tuple("933113495304679494", Discord.TextChannel),
    cursed_code: tuple("855220292736516128", Discord.TextChannel),
    suggestion_dashboard: tuple("908928083879415839", Discord.ThreadChannel),
    suggestion_action_log: tuple("909309608512880681", Discord.ThreadChannel),
    today_i_learned: tuple("873682069325217802", Discord.TextChannel),
    goals2024: tuple("1189255286364569640", Discord.TextChannel),
    goals2025: tuple("1323734788707848253", Discord.TextChannel),
    days_since_last_incident: tuple("1195920462958575676", Discord.TextChannel),
    literally_1984: tuple("1097993854214488154", Discord.TextChannel),
    lore: tuple("890067781628866620", Discord.TextChannel),
    bot_dev_internal: tuple("1166517065763536977", Discord.TextChannel),
    pin_archive: tuple("1284234644396572714", Discord.TextChannel),
    skill_role_log: tuple("1315023714206617610", Discord.TextChannel),
    polls: tuple("1319336135213846568", Discord.NewsChannel),
    // red telephone
    red_telephone_alerts: tuple("1140096352278290512", Discord.TextChannel),
    // error log
    log: tuple("1260777903700971581", Discord.TextChannel),
};

const categories_map = {
    staff_logs: "1135927261472755712",
    staff: "873125551064363028",
    meta: "360691699288113163",
    tutoring: "923430684041818153",
    cpp_help: "897465499535949874",
    c_help: "931970218442493992",
    discussion: "855220194887335977",
    specialized: "360691955031867392",
    community: "1131921460034801747",
    off_topic: "360691500985745409",
    misc: "506274316623544320",
    bot_dev: "1166516815472640050",
    voice: "360692425242705921",
    archive: "910306041969913938",
    private_archive: "455278783352537099",
    challenges_archive: "429594248099135488",
    meta_archive: "910308747929321492",
};

const roles_map = {
    muted: "815987333094178825",
    monke: "1139378060450332752",
    no_off_topic: "879419994004422666",
    no_suggestions: "831567015457980447",
    no_suggestions_at_all: "895011256023535657",
    no_reactions: "880152014036819968",
    no_images: "1181029004866760854",
    no_threads: "870181444742447135",
    no_serious_off_topic: "921116034948272260",
    no_til: "883474632370454588",
    no_memes: "982307359370141756",
    moderators: "847915341954154536",
    root: "331719468440879105",
    pink: "888158339878490132",
    server_booster: "643013330616844333",
    historian: "890067617069551646",
    official_bot: "331886851784704001",
    featured_bot: "995847409374605392",
    jedi_council: "1138950835208990750",
    herald: "1095555811536797787",
    linked_github: "1080596526478397471",
};

const skill_roles_map = {
    beginner: "784733371275673600",
    intermediate: "331876085820030978",
    proficient: "849399021838925834",
    advanced: "331719590990184450",
    expert: "331719591405551616",
};

export const skill_roles_order = ["beginner", "intermediate", "proficient", "advanced", "expert"];

export const skill_roles_order_id = [
    "784733371275673600",
    "331876085820030978",
    "849399021838925834",
    "331719590990184450",
    "331719591405551616",
];

// General config
// TODO: Can eliminate this stuff
export const root_ids = new Set([
    "199943082441965577", // zelis
    "110756651694297088", // vincent
    "89441674844995584", // styx
    "313597351262683138", // dot
    // prevent Wheatley reactions being removed in server suggestions and also allow some elegant handling
    "597216680271282192", // wheatley
]);

export const root_mod_ids = [
    "199943082441965577", // zelis
    "230282234085638155", // cas
    "719255892813545502", // sampersand
    "89441674844995584", // styx
    "110756651694297088", // vincent
    "138014214093668353", // dxpower
    "313597351262683138", // dot
    "413463039145410560", // karnage
    "512649489300062228", // quicknir
    "446584068746772480", // yinsei
    "213759964789866496", // levi
    "162964325823283200", // eisen
];

export const root_mod_ids_set = new Set(root_mod_ids);

type EventMap = {
    wheatley_ready: () => void;
    issue_moderation: (moderation: moderation_entry) => void;
    update_moderation: (moderation: mongo.WithId<moderation_entry>) => void;
};

export class Wheatley {
    readonly event_hub = new TypedEventEmitter<EventMap>();
    readonly components = new Map<string, BotComponent>();
    readonly tracker: MemberTracker; // TODO: Rename
    readonly log_limiter: LogLimiter;

    private command_handler: CommandHandler;

    database: WheatleyDatabaseProxy;
    virustotal: Virustotal | null;

    // whether wheatley is ready (client is ready + wheatley has set up)
    ready = false;

    // Application ID, must be provided in auth.json
    readonly id: string;
    // Guild ID, falls back onto TCCPP if not provided in auth.json.
    readonly guildId: string;
    // True if freestanding mode is enabled. Defaults to false.
    readonly freestanding: boolean;

    // Some emojis
    readonly pepereally = "<:pepereally:643881257624666112>";
    readonly stackoverflow_emote = "<:stackoverflow:1074747016644661258>";
    readonly microsoft_emote = "<:microsoft:1165512917047853127>";
    readonly tux_emote = "<:tux:1165505626894520361>";
    readonly apple_emote = "<:apple:1165508607798943754>";
    readonly success = "<:success:1138616548630745088>";
    readonly error = "<:error:1138616562958483496>";
    readonly wheatley = "<:wheatley:1147938076551827496>";

    // TCCPP stuff
    TCCPP: Discord.Guild;
    user: Discord.User;

    log_channel: Discord.TextBasedChannel | null = null;

    channels: {
        // ["prototype"] gets the instance type, eliminating the `typeof`. InstanceType<T> doesn't work for a protected
        // constructor, weirdly.
        [k in keyof typeof channels_map]: (typeof channels_map)[k][1]["prototype"];
    } = {} as any;

    categories: {
        [k in keyof typeof categories_map]: Discord.CategoryChannel;
    } = {} as any;

    thread_based_channel_ids = new Set([
        "802541516655951892", // server-suggestions
        "594212045621035030", // showcase
        "873682069325217802", // today-i-learned
    ]);

    roles: {
        [k in keyof typeof roles_map]: Discord.Role;
    } = {} as any;
    skill_roles: {
        [k in keyof typeof skill_roles_map]: Discord.Role;
    } = {} as any;

    // TODO: Eliminate pre-set value
    root_mod_list = "jr.0, dot42, styxs, or _64";

    message_counter = new PromClient.Counter({
        name: "tccpp_message_count",
        help: "TCCPP message count",
        labelNames: ["type"],
    });

    private mom_ping: string;

    //
    // Bot setup
    //

    constructor(
        readonly client: Discord.Client,
        config: wheatley_config,
    ) {
        this.id = config.id;
        this.guildId = config.guild;
        this.freestanding = config.freestanding ?? false;

        this.mom_ping = config.mom ? ` <@${config.mom}>` : "";

        this.tracker = new MemberTracker(this);
        this.log_limiter = new LogLimiter(this);

        // temporary until fixed in djs or @types/node
        (this.client as any).setMaxListeners(35);

        this.client.on("error", error => {
            M.error(error);
        });

        this.setup(config).catch(this.critical_error.bind(this));
    }

    async setup(config: wheatley_config) {
        assert(this.freestanding || config.mongo, "Missing MongoDB credentials");
        if (config.mongo) {
            this.database = await WheatleyDatabase.create(this.get_initial_wheatley_info.bind(this), config.mongo);
        }
        if (config.virustotal) {
            this.virustotal = new Virustotal(config.virustotal);
        }
        if (config.metrics) {
            setup_metrics_server(config.metrics.port, config.metrics.hostname);
        }

        this.client.on("ready", () => {
            (async () => {
                // Fetch the log channel immediately
                if (!config.freestanding) {
                    const channel = await this.client.channels.fetch(channels_map.log[0]);
                    this.log_channel = channel && channel.isTextBased() ? channel : null;
                }

                this.info("Bot started");

                await this.fetch_guild_info();

                const command_set_builder = new CommandSetBuilder(this);
                for (const component of this.components.values()) {
                    try {
                        await component.setup(command_set_builder);
                    } catch (e) {
                        this.critical_error(e);
                    }
                }
                const { text_commands, other_commands } = await command_set_builder.finalize(config.token);
                this.command_handler = new CommandHandler(this, text_commands, other_commands);

                this.event_hub.emit("wheatley_ready");
                this.ready = true;
                this.client.on("messageCreate", (message: Discord.Message) => {
                    this.on_message(message).catch(this.critical_error.bind(this));
                });
                if (!this.freestanding) {
                    await this.populate_caches();
                }
            })().catch(this.critical_error.bind(this));
        });

        for await (const file of globIterate("**/components/*.js", {
            ignore: config.exclude,
            cwd: import.meta.dirname,
        })) {
            const default_export = (await import(`./${file}`)).default;
            if (default_export !== undefined) {
                await this.add_component(default_export);
            }
        }

        M.debug("Logging in");

        await this.client.login(config.token);
    }

    async fetch_guild_info() {
        const wrap = async <T>(fn: () => Promise<T>): Promise<T | null> => {
            try {
                return await fn();
            } catch (e) {
                if (!this.freestanding) {
                    this.critical_error(e);
                    throw e;
                } else {
                    // absorb error
                    return null;
                }
            }
        };
        const fudged_unwrap = <T>(value: T | null | undefined): T => {
            if (!this.freestanding) {
                // for the real bot actually check
                return unwrap(value);
            } else {
                return value as T;
            }
        };
        // Preliminary loads
        this.TCCPP = fudged_unwrap(await wrap(() => this.client.guilds.fetch(this.guildId)));
        this.user = fudged_unwrap(await wrap(() => this.client.users.fetch(this.id)));
        // Channels
        await Promise.all(
            Object.entries(channels_map).map(async ([k, [id, type]]) => {
                const channel = await wrap(() => this.client.channels.fetch(id));
                if (this.freestanding && channel === null) {
                    return;
                }
                assert(channel !== null, `Channel ${k} ${id} not found`);
                assert(channel instanceof type, `Channel ${k} ${id} not of the expected type`);
                this.channels[k as keyof typeof channels_map] = channel as any;
                M.log(`Fetched channel ${k}`);
            }),
        );
        // Categories
        await Promise.all(
            Object.entries(categories_map).map(async ([k, id]) => {
                const category = await wrap(() => this.client.channels.fetch(id));
                if (this.freestanding && category === null) {
                    return;
                }
                assert(category !== null, `Category ${k} ${id} not found`);
                assert(category instanceof Discord.CategoryChannel, `Category ${k} ${id} not of the expected type`);
                this.categories[k as keyof typeof categories_map] = category;
                M.log(`Fetched category ${k}`);
            }),
        );
        // Roles
        await Promise.all(
            Object.entries(roles_map).map(async ([k, id]) => {
                const role = await wrap(() => this.TCCPP.roles.fetch(id));
                if (this.freestanding && role === null) {
                    return;
                }
                assert(role !== null, `Role ${k} ${id} not found`);
                this.roles[k as keyof typeof roles_map] = role;
                M.log(`Fetched role ${k}`);
            }),
        );
        await Promise.all(
            Object.entries(skill_roles_map).map(async ([k, id]) => {
                const role = await wrap(() => this.TCCPP.roles.fetch(id));
                if (this.freestanding && role === null) {
                    return;
                }
                assert(role !== null, `Role ${k} ${id} not found`);
                this.skill_roles[k as keyof typeof skill_roles_map] = role;
                M.log(`Fetched role ${k}`);
            }),
        );
        // fetch list of roots and mods, replace hard-coded list
        await wrap(() => this.fetch_root_mod_list(this.client));
    }

    async add_component<T extends BotComponent>(component: { new (w: Wheatley): T; get is_freestanding(): boolean }) {
        if (!this.freestanding || component.is_freestanding) {
            M.log(`Initializing ${component.name}`);
            assert(!this.components.has(component.name), "Duplicate component name");
            const instance = new component(this);
            this.components.set(component.name, instance);
            return instance;
        } else {
            return null;
        }
    }

    async populate_caches() {
        // Load a couple hundred messages for every channel we're in
        const channels: Record<string, { channel: Discord.TextBasedChannel; last_seen: number; done: boolean }> = {};
        for (const [_, channel] of await this.TCCPP.channels.fetch()) {
            if (channel?.isTextBased() && !channel.name.includes("archived-")) {
                M.debug(`Loading recent messages from ${channel.name}`);
                //await channel.messages.fetch({
                //    limit: 100,
                //    cache: true
                //});
                channels[channel.id] = {
                    channel,
                    last_seen: Date.now(),
                    done: false,
                };
            }
        }
        for (let i = 0; i < 3; i++) {
            M.log("Fetches round", i);
            const promises: Promise<any>[] = [];
            for (const [id, { channel, last_seen, done }] of Object.entries(channels)) {
                if (!done) {
                    promises.push(
                        (async () => {
                            const messages = await channel.messages.fetch({
                                limit: 100,
                                cache: true,
                                before: forge_snowflake(last_seen - 1),
                            });
                            channels[id].last_seen = Math.min(
                                ...[...messages.values()].map(message => message.createdTimestamp),
                            );
                            if (messages.size == 0) {
                                channels[id].done = true;
                            }
                        })(),
                    );
                }
            }
            await Promise.all(promises);
        }
    }

    //
    // Logging
    //

    critical_error(arg: any) {
        M.error(arg);
        if (!this.log_channel) {
            return;
        }
        send_long_message(this.log_channel, `🛑 Critical error: ${to_string(arg)}` + this.mom_ping)
            .catch(() => M.error)
            .finally(() => {
                if (arg instanceof Error) {
                    Sentry.captureException(arg);
                } else {
                    Sentry.captureMessage(to_string(arg));
                }
            });
    }

    ignorable_error(arg: any) {
        M.error(arg);
        if (!this.log_channel) {
            return;
        }
        send_long_message(this.log_channel, `⚠️ Ignorable error: ${to_string(arg)}`)
            .catch(M.error)
            .finally(() => {
                if (arg instanceof Error) {
                    Sentry.captureException(arg);
                } else {
                    Sentry.captureMessage(to_string(arg));
                }
            });
    }

    info(message: string) {
        M.info(message);
        if (!this.log_channel) {
            return;
        }
        send_long_message(this.log_channel, `ℹ️ Info: ${message}`)
            .catch(M.error)
            .finally(() => {
                Sentry.captureMessage(message);
            });
    }

    alert(message: string) {
        M.info(message);
        if (!this.log_channel) {
            return;
        }
        send_long_message(this.log_channel, `🚨 Alert: ${message}` + this.mom_ping)
            .catch(M.error)
            .finally(() => {
                Sentry.captureMessage(message);
            });
    }

    //
    // Common discord utilities
    //

    llog(channel: LoggableChannel, message: Discord.MessageCreateOptions) {
        this.log_limiter.log(channel, message);
    }

    is_forum_help_channel(id: string) {
        return [this.channels.cpp_help.id, this.channels.c_help.id].includes(id);
    }

    is_forum_help_thread(thread: Discord.ThreadChannel) {
        return thread.parentId != null && this.is_forum_help_channel(thread.parentId);
    }

    get_corresponding_text_help_channel(thread: Discord.ThreadChannel) {
        if (thread.parentId == this.channels.cpp_help.id) {
            return this.channels.cpp_help_text;
        } else if (thread.parentId == this.channels.c_help.id) {
            return this.channels.c_help_text;
        }
        assert(false);
    }

    // utility: returns the channel for regular channels or the thread / forum post parent
    top_level_channel(channel: Discord.TextBasedChannel) {
        if (channel instanceof Discord.ThreadChannel && channel.parentId != null) {
            return channel.parentId;
        } else {
            return channel.id;
        }
    }

    /**
     * Search for a specific channel by name if the provided name is not found then instead search by id.
     */
    async get_channel(name: string, id: string, guild_to_check: Discord.Guild = this.TCCPP) {
        if (process.env.NODE_ENV === "development") {
            const channel_by_name = guild_to_check.channels.cache.find(channel => channel.name === name);
            if (channel_by_name) {
                return channel_by_name;
            }
        }

        const channel_by_id = guild_to_check.channels.cache.get(id);
        if (channel_by_id) {
            return channel_by_id as Discord.GuildChannel;
        }

        return null;
    }

    async fetch_message_reply(message: Discord.Message) {
        const ref = unwrap(message.reference);
        assert(ref.guildId === message.guildId);
        assert(ref.channelId === message.channelId);
        const channel = unwrap(await this.client.channels.fetch(ref.channelId));
        assert(channel.isTextBased());
        const reply_message = await channel.messages.fetch(unwrap(ref.messageId));
        return reply_message;
    }

    is_root(user: Discord.User | Discord.PartialUser | Discord.APIUser): boolean {
        //return member.roles.cache.some(r => r.id == root_role_id);
        return root_ids.has(user.id);
    }

    is_authorized_mod(member: Discord.GuildMember | Discord.User | string): boolean {
        if (is_string(member)) {
            return root_mod_ids_set.has(member);
        } else {
            return root_mod_ids_set.has(member.id);
        }
    }

    has_skill_roles_other_than_beginner(member: Discord.GuildMember) {
        const non_beginner_skill_role_ids = Object.entries(this.skill_roles)
            .filter(([name, _]) => name !== "beginner")
            .map(([_, role]) => role.id);
        return member.roles.cache.some(role => non_beginner_skill_role_ids.includes(role.id));
    }

    // higher is better
    get_skill_role_index(role: Discord.Role | string) {
        return skill_roles_order_id.indexOf(role instanceof Discord.Role ? role.id : role);
    }

    async fetch_root_mod_list(client: Discord.Client) {
        const tags = [];
        for (const id of root_mod_ids) {
            tags.push((await client.users.fetch(id)).tag);
        }
        assert(tags.length > 3);
        this.root_mod_list = tags.slice(0, tags.length - 1).join(", ") + ", or " + tags[tags.length - 1];
        M.debug("root_mod_list", [this.root_mod_list]);
    }

    async is_public_channel(channel: Discord.GuildTextBasedChannel | Discord.TextBasedChannel) {
        return (
            !(channel instanceof Discord.ForumChannel) &&
            !channel.isDMBased() &&
            !(channel.isThread() && channel.type == Discord.ChannelType.PrivateThread) &&
            channel.permissionsFor(this.TCCPP.roles.everyone).has("ViewChannel")
        );
    }

    // case-insensitive
    get_role_by_name(name: string) {
        return unwrap(this.TCCPP.roles.cache.find(role => role.name.toLowerCase() === name.toLowerCase()));
    }

    async try_fetch_tccpp_member(
        options: Discord.GuildMember | Discord.UserResolvable | Discord.FetchMemberOptions,
    ): Promise<Discord.GuildMember | null> {
        if (options instanceof Discord.GuildMember) {
            if (options.guild.id == this.guildId) {
                return options;
            } else {
                return await this.try_fetch_tccpp_member(options.id);
            }
        } else {
            try {
                return await this.TCCPP.members.fetch(options);
            } catch (e) {
                // unknown member/user
                if (e instanceof Discord.DiscordAPIError && (e.code === 10007 || e.code == 10013)) {
                    return null;
                } else {
                    throw e;
                }
            }
        }
    }

    async get_display_name(thing: Discord.Message | Discord.User): Promise<string> {
        if (thing instanceof Discord.User) {
            const user = thing;
            try {
                return (await this.TCCPP.members.fetch(user.id)).displayName;
            } catch {
                // user could potentially not be in the server
                return user.displayName;
            }
        } else if (thing instanceof Discord.Message) {
            const message = thing;
            if (message.member == null) {
                return this.get_display_name(message.author);
            } else {
                return message.member.displayName;
            }
        } else {
            assert(false);
        }
    }

    //
    // Basic interaction and command stuff
    //

    get_command(command: string) {
        return this.command_handler.get_command(command);
    }

    register_non_command_bot_reply(trigger: Discord.Message, message: Discord.Message) {
        this.command_handler.register_non_command_bot_reply(trigger, message);
    }

    increment_message_counters(message: Discord.Message) {
        try {
            if (message.guildId == this.guildId) {
                if (!message.author.bot) {
                    this.message_counter.labels({ type: "normal" }).inc();
                } else {
                    this.message_counter.labels({ type: "bot" }).inc();
                }
                if (message.author.id == unwrap(this.client.user).id) {
                    this.message_counter.labels({ type: "wheatley" }).inc();
                }
            }
        } catch (e) {
            this.critical_error(e);
        }
    }

    async on_message(message: Discord.Message) {
        this.increment_message_counters(message);
    }

    get_initial_wheatley_info(): wheatley_database_info {
        return {
            id: "main",
            server_suggestions: {
                last_scanned_timestamp: SERVER_SUGGESTION_TRACKER_START_TIME,
            },
            modmail_id_counter: 0,
            the_button: {
                button_presses: 0,
                last_reset: Date.now(),
                longest_time_without_reset: 0,
            },
            starboard: {
                delete_emojis: [],
                ignored_emojis: [],
                negative_emojis: [],
                repost_emojis: [],
            },
            moderation_case_number: 0,
            watch_number: 0,
        };
    }
}
