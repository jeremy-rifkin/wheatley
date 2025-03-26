import * as Discord from "discord.js";
import * as https from "https";

import { strict as assert } from "assert";

import { colors, DAY } from "../common.js";
import { BotComponent } from "../bot-component.js";
import { Wheatley } from "../wheatley.js";
import { build_description, capitalize } from "../utils/strings.js";
import Mute from "./moderation/mute.js";

const ACTION_THRESHOLD = 5;

export default class AntiExecutable extends BotComponent {
    static override get is_freestanding() {
        return true;
    }

    // Elf:  0x7F 0x45 0x4c 0x46 at offset 0
    // Mach: 0xfe 0xed 0xfa 0xce offset 0
    //       0xce 0xfa 0xed 0xfe
    //       0xfe 0xed 0xfa 0xcf
    //       0xcf 0xfa 0xed 0xfe
    // PE:   4D 5A offset 0
    //   and 50 45 00 00 at variable offset
    static readonly executable_magic: [number, Buffer][] = [
        [0, Buffer.from([0x7f, 0x45, 0x4c, 0x46])], // elf
        [0, Buffer.from([0xfe, 0xed, 0xfa, 0xce])], // mach-o 32-bit big endian
        [0, Buffer.from([0xce, 0xfa, 0xed, 0xfe])], // mach-o 32-bit little endian
        [0, Buffer.from([0xfe, 0xed, 0xfa, 0xcf])], // mach-o 64-bit big endian
        [0, Buffer.from([0xcf, 0xfa, 0xed, 0xfe])], // mach-o 64-bit little endian
        [0, Buffer.from([0xca, 0xfe, 0xba, 0xbe])], // mach-o universal
        [0, Buffer.from([0xbe, 0xba, 0xfe, 0xca])], // mach-o universal swapped
        [0, Buffer.from([0x4d, 0x5a])], // DOS MZ / PE
    ];

    static readonly archive_magic: [number, Buffer][] = [
        // Source for the archives and compressed files magic values:
        //  https://en.wikipedia.org/wiki/List_of_file_signatures
        // [0, Buffer.from([0x1f, 0x9d])], // Compressed file using Lempel-Ziv-Welch algorithm.
        // [0, Buffer.from([0x1f, 0xa0])], // Compressed file using LZH algorithm
        [0, Buffer.from([0x1f, 0x8b])], // GZIP compressed files
        [0, Buffer.from([0x78, 0xf9])], // ZLIB (Best compression, with preset dictionary)
        [0, Buffer.from([0x78, 0x01])], // ZLIB (No Compression)
        [0, Buffer.from([0x78, 0x5e])], // ZLIB (Best Speed, no preset dictionary)
        [0, Buffer.from([0x78, 0x9c])], // ZLIB (Default compresson, no preset dictionary)
        [0, Buffer.from([0x78, 0xda])], // ZLIB (Best compression, no preset dictionary)
        [0, Buffer.from([0x78, 0x20])], // ZLIB (No compression, with preset dictionary)
        [0, Buffer.from([0x78, 0x7d])], // ZLIB (Best speed, with preset dictionary)
        [0, Buffer.from([0x78, 0xbb])], // ZLIB (Default compression, with preset dictionary)
        [0, Buffer.from([0x1a, 0x08])], // ARC archive file
        // [0, Buffer.from([0x4f, 0x41, 0x52])], // OAR file archive
        // [2, Buffer.from([0x2d, 0x68, 0x6c, 0x30, 0x2d])], // LZH archive file method 0 (No compression)
        // [2, Buffer.from([0x2d, 0x68, 0x6c, 0x35, 0x2d])], // LZH archive file method 5 (8KiB sliding window)
        [0, Buffer.from([0x4c, 0x5a, 0x49, 0x50])], // LZIP Compressed file
        [0, Buffer.from([0x50, 0x4b, 0x03, 0x04])], // ZIP File
        [0, Buffer.from([0x50, 0x4b, 0x05, 0x06])], // ZIP File (Empty)
        [0, Buffer.from([0x50, 0x4b, 0x07, 0x08])], // ZIP File (Spanned Archive)
        // [0, Buffer.from([0x78, 0x61, 0x72, 0x21])], // eXtensible ARchive format
        // [0, Buffer.from([0x30, 0x37, 0x30, 0x37, 0x30, 0x37])], // CPIO archive file
        // [0, Buffer.from([0x52, 0x61, 0x72, 0x21, 0xa1, 0x07, 0x00])], // Roshal ARchive (v1.50+)
        // [0, Buffer.from([0x52, 0x61, 0x72, 0x21, 0xa1, 0x07, 0x01, 0x00])], // Roshal ARchive (v5.00+)
        [257, Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x30, 0x30])], // tar archive
        [257, Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0x00])], // tar archive
        // [0, Buffer.from([0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33])], // Microsoft compressed Quantum format.
        // [0, Buffer.from([0x52, 0x53, 0x56, 0x4b, 0x44, 0x41, 0x54, 0x41])], // QuickZip rs compressed archive
        [0, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])], // 7zip File Format
        [0, Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])], // XZ compression utility
        // [0, Buffer.from([0x62, 0x76, 0x78, 0x32])], // LZFSE - Lempel-Ziv style data compression algorithm.
        [0, Buffer.from([0x28, 0xb5, 0x2f, 0xfd])], // Zstandard compress
        // [0, Buffer.from([0x2a, 0x2a, 0x41, 0x43, 0x45, 0x2a, 0x2a])], // ACE compressed file format
    ];

    looks_like_executable(buffer: Buffer) {
        for (const magic of AntiExecutable.executable_magic) {
            if (buffer.subarray(magic[0], magic[1].length).equals(magic[1])) {
                return true;
            }
        }
        return false;
    }

    looks_like_archive(buffer: Buffer) {
        for (const magic of AntiExecutable.archive_magic) {
            if (buffer.subarray(magic[0], magic[1].length).equals(magic[1])) {
                return true;
            }
        }
        return false;
    }

    fetch(url: string, limit?: number) {
        return new Promise<Buffer>((resolve, reject) => {
            let buffer = Buffer.alloc(0);
            https
                .get(url, res => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Request failed status code: ${res.statusCode}`));
                        return;
                    }
                    res.on("data", chunk => {
                        buffer = Buffer.concat([buffer, chunk]);
                        if (limit !== undefined && buffer.length >= limit) {
                            res.destroy();
                            resolve(buffer);
                        }
                    });
                    res.on("end", () => {
                        resolve(buffer);
                    });
                    res.on("error", reject);
                })
                .on("error", reject)
                .end();
        });
    }

    async virustotal_scan(
        file_buffer: Buffer,
        flag_messsage: Discord.Message,
        author: Discord.User,
        original_message: Discord.Message | null,
    ) {
        if (!this.wheatley.virustotal) {
            return;
        }
        const res = await this.wheatley.virustotal.upload(file_buffer);
        const bad_count = res.stats.suspicious + res.stats.malicious;
        const flag_reply = await flag_messsage.reply({
            embeds: [
                new Discord.EmbedBuilder()
                    .setColor(bad_count > 0 ? colors.red : colors.wheatley)
                    .setTitle("VirusTotal result")
                    .setURL(res.url)
                    .setDescription(
                        build_description(
                            ...Object.entries(res.stats).map(([name, count]) => `${capitalize(name)}: ${count}`),
                        ),
                    ),
            ],
        });
        if (bad_count >= ACTION_THRESHOLD) {
            if (original_message) {
                original_message.delete().catch(this.wheatley.critical_error.bind(this.wheatley));
            }
            (this.wheatley.components.get("Mute") as Mute)
                .issue_moderation_internal(
                    author,
                    this.wheatley.user,
                    DAY,
                    `Automatic mute for uploading a file flagged as potentially malicious. ` +
                        "A moderator will review this.",
                    {
                        type: "mute",
                    },
                )
                .catch(this.wheatley.critical_error.bind(this.wheatley))
                .finally(() => {
                    this.wheatley.channels.staff_action_log
                        .send({
                            content:
                                `<@&${this.wheatley.roles.moderators.id}> Please review automatic 24h mute of ` +
                                `<@${author.id}> (id ${author.id}) for a potentially malicious upload, ` +
                                `virustotal result: ${flag_reply.url}`,
                            allowedMentions: {
                                roles: [this.wheatley.roles.moderators.id],
                            },
                        })
                        .catch(this.wheatley.critical_error.bind(this.wheatley));
                });
        }
    }

    async scan_attachments(
        attachments: Discord.Attachment[],
        flag_message: Discord.Message,
        author: Discord.User,
        original_message: Discord.Message | null,
    ) {
        await Promise.all(
            attachments.map(async attachment => {
                // download
                let file_buffer: Buffer;
                try {
                    file_buffer = await this.fetch(attachment.url);
                } catch (e) {
                    this.wheatley.critical_error(e);
                    return;
                }
                // virustotal
                await this.virustotal_scan(file_buffer, flag_message, author, original_message);
            }),
        );
    }

    async handle_executables(message: Discord.Message, attachments: Discord.Attachment[]) {
        const quote = await this.utilities.make_quote_embeds([message]);
        await message.delete();
        assert(!(message.channel instanceof Discord.PartialGroupDMChannel));
        await message.channel.send(`<@${message.author.id}> Please do not send executable files`);
        const flag_message = await this.wheatley.channels.staff_flag_log.send({
            content: `:warning: Executable file(s) detected`,
            ...quote,
        });
        await this.scan_attachments(attachments, flag_message, message.author, null);
    }

    async handle_archives(message: Discord.Message, attachments: Discord.Attachment[]) {
        const quote = await this.utilities.make_quote_embeds([message]);
        const flag_message = await this.wheatley.channels.staff_flag_log.send({
            content: `:warning: Archive file(s) detected`,
            ...quote,
        });
        await this.scan_attachments(attachments, flag_message, message.author, message);
    }

    override async on_message_create(message: Discord.Message) {
        if (message.author.bot) {
            return;
        }
        if (message.attachments.size > 0) {
            const executables: Discord.Attachment[] = [];
            const archives: Discord.Attachment[] = [];
            for (const [_, attachment] of message.attachments) {
                const res = await this.fetch(attachment.url, 512);
                if (this.looks_like_executable(res)) {
                    executables.push(attachment);
                } else if (this.looks_like_archive(res)) {
                    archives.push(attachment);
                }
            }
            if (executables.length > 0) {
                await this.handle_executables(message, [...executables, ...archives]);
            } else if (archives.length > 0) {
                await this.handle_archives(message, archives);
            }
        }
    }
}
