# Wheatley

[![build](https://github.com/TCCPP/wheatley/actions/workflows/build.yml/badge.svg)](https://github.com/TCCPP/wheatley/actions/workflows/build.yml)
[![test](https://github.com/TCCPP/wheatley/actions/workflows/test.yml/badge.svg)](https://github.com/TCCPP/wheatley/actions/workflows/test.yml)
[![eslint](https://github.com/TCCPP/wheatley/actions/workflows/eslint.yml/badge.svg)](https://github.com/TCCPP/wheatley/actions/workflows/eslint.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=TCCPP_wheatley&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=TCCPP_wheatley)

This repository contains the source code for the Wheatley bot, made for the Together C & C++ discord server.

## Project Structure

- `indexes/` Code for processing cppreference and man7 data to create a searchable index
- `src/` Main source code for the bot
  - `algorithm/` Algorithmic utilities for the bot, such as levenshtein distance
  - `components/` Bot components
  - `infra/` Bot infrastructure, such as database interaction
  - `test/` Test cases
  - `wheatley-private/` Private components, these are primarily internal moderation and administration tools such as
    raid detection and handling.

The bot is very modular and most components are completely independent of other components.

## Local Development

In order to run the bot locally you'll need to create a bot and setup some basic information for Wheatley:

1. Go to https://discord.com/developers/applications and create an application
2. Move or copy `config.default.json` to `config.json`
3. Go to Application Settings > Bot
   1. Request or reset your bot's token, copy it to `token` in `config.json`
   2. Under Privileged Gateway Intents, select presence intent, server members intent, and the message content intent
4. Go to Application Settings > Installation
   1. Select "Guild Install"
   2. Select "Discord Provided Link"
   3. Select scopes: `applications.commands` and `bot`
   4. Select permissions: `Administrator`
5. Setup a test server (ask on TCCPP for help if needed)
6. Install your bot on a test server

Once that is setup, the easiest way to get started with local bot development is to run `make run-dev-container`, builds
a container and runs it with podman. Once the container builds, run `make dev` in the container's shell and you should
be good to go.

The bot relies on a lot of server-specific information, such as IDs for channels and roles. Components which do not rely
on any server-specific information are marked as freestanding. When developing locally, configure the bot as
freestanding (see below). If you are working on a component which relies on server specific information, the best
solution currently is the following:

1. Look at what server-specific pieces the component needs (channels, roles, etc.) and create copies in your development
   server. Server-specific pieces needed by the component can be found easily by searching for `this.wheatley.channels.`
   and `this.wheatley.roles.`.
2. Update constants in `src/wheatley.ts` as needed - all constants are at the top of the file.
3. Set the component to be enabled in freestanding mode with:

```ts
    static override get is_freestanding() {
        return true;
    }
```

## config.json

Secrets and other bot info must be configured in the `config.json` file. An example looks like:

```json
{
  "id": "<bot id>",
  "guild": "<guild id>",
  "token": "<discord api token>",
  "mom": "<your user id>", // to be pinged when things go wrong
  "mongo": {
    "user": "wheatley",
    "password": "<mongo password>",
    "host": "127.0.0.1", // optional
    "port": 27017 // optional
  },
  "freestanding": false, // optional,
  "exclude": [
    // optional
    "components/the-button.js",
    "modules/tccpp/components/buzzwords.js",
    "modules/tccpp/private/**"
  ]
}
```

Mongo credentials can be omitted locally if you don't need to work on components that use mongo. `freestanding: true`
can be specified to turn on only components which don't rely on channels etc. specific to Together C & C++ to exist.
Freestanding mode also disables connecting to MongoDB.

## Bot Component Abstraction

The bot is built of modular components. The BotComponent base class defines the following api:

```ts
export class BotComponent {
  static get is_freestanding() {
    return false;
  }
  // Called after all components are constructed and the bot logs in, commands can be added here
  async setup(commands: CommandSetBuilder);
  // Called when Wheatley is ready
  async on_ready();
  // General discord events
  async on_message_create?(message: Discord.Message): Promise<void>;
  async on_message_delete?(message: Discord.Message | Discord.PartialMessage): Promise<void>;
  async on_message_update?(
    old_message: Discord.Message | Discord.PartialMessage,
    new_message: Discord.Message | Discord.PartialMessage,
  ): Promise<void>;
  async on_interaction_create?(interaction: Discord.Interaction): Promise<void>;
  async on_guild_member_add?(member: Discord.GuildMember): Promise<void>;
  async on_guild_member_update?(
    old_member: Discord.GuildMember | Discord.PartialGuildMember,
    new_member: Discord.GuildMember,
  ): Promise<void>;
  async on_reaction_add?(
    reaction: Discord.MessageReaction | Discord.PartialMessageReaction,
    user: Discord.User | Discord.PartialUser,
  ): Promise<void>;
  async on_reaction_remove?(
    reaction: Discord.MessageReaction | Discord.PartialMessageReaction,
    user: Discord.User | Discord.PartialUser,
  ): Promise<void>;
  async on_thread_create?(thread: Discord.ThreadChannel): Promise<void>;
}
```

A component should extend BotComponent and override methods as needed.

## Command Abstraction

For the bot I've created a command abstraction that internally handles both text and slash commands. An example
component and command looks like this:

```ts
export default class Echo extends BotComponent {
  static override get is_freestanding() {
    return true;
  }

  override async setup(commands: CommandSetBuilder) {
    commands.add(
      new TextBasedCommandBuilder("echo")
        .set_description("echo")
        .add_string_option({
          title: "input",
          description: "The input to echo back",
          required: true,
        })
        .set_handler(this.echo.bind(this)),
    );
  }

  async echo(command: TextBasedCommand, input: string) {
    M.debug("Received echo command", input);
    await command.reply(input, true);
  }
}
```

`TextBasedCommandBuilder` defines the following methods:

- Configuration:
  - `set_description(description)`
  - `set_handler(handler)`
  - `set_slash(slash)`
  - `set_permissions(permissions_bigint)`
- Options:
  - `add_string_option(parameter_options)`
  - `add_number_option(parameter_options)`
  - `add_user_option(parameter_options)`
  - `add_role_option(parameter_options)`

Each `parameter_options` must contain at least a title and description.

A user option will translate to a user picker in a slash command and in text either a user mention or a user id is
accepted. A role option will translate to a role picker in a slash command and in text either a case-insensitive role
name is accepted. For a string option, if it's the last string option the entire remaining command body is taken (after
other arguments). If the string does not correspond to the last positional option, either one whitespace-terminated word
is read or a regex can be specified.

## Database

The bot uses MongoDB. It previously used a giant json file (the migration script is located in the scripts folder). The
development docker container sets up and orchestrates a mongodb server for the bot to use.
