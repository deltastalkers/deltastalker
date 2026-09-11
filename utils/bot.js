import { Client, Events, GatewayIntentBits, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';

export const makeClient = (config, rolesMessage, setRolesMessage) => {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
    client.on(Events.ClientReady, async () => {
        try {
            log(`Logged into Discord as ${client.user.tag}!`)
            client.user.setActivity('stalking Toby Fox 👀', { type: ActivityType.Watching });
            const channel = await getChannel(config.channels.info);
            if (rolesMessage) {
                try {
                    const message = await channel.messages.fetch(rolesMessage);
                    if (message) return;
                } catch (e) {
                    log("Roles message no longer exists, recreating", e);
                };
            };
            const row = new ActionRowBuilder();
            for (const role in config.roles) {
                const [_, emoji] = config.roles[role];
                const button = new ButtonBuilder()
                    .setCustomId(role)
                    .setLabel(role)
                    .setEmoji(emoji)
                    .setStyle(ButtonStyle.Success);
                row.addComponents(button);
            };
            const message = await channel.send({ content: "come get yo roles yall\n> by default, you receive all notifications, feel free to remove/add any!", components: [row] });
            setRolesMessage(message.id);
        } catch (e) {
            log("Failed to start Discord bot", e);
        };
    });
    client.on(Events.GuildMemberAdd, async member => {
        try {
            const channel = await getChannel(config.channels.logs);
            const embed = new EmbedBuilder()
                .setColor(0x40ff40)
                .setDescription(`<@${member.id}> (\`${member.id}\`) joined!`);
            await channel.send({ embeds: [embed] });
            await member.roles.add(Object.values(config.roles).map(r => r[0]), "joined");
        } catch (e) {
            log("Failed to log user joining", e);
        };
    });
    client.on(Events.GuildMemberRemove, async member => {
        try {
            const channel = await getChannel(config.channels.logs);
            const embed = new EmbedBuilder()
                .setColor(0xff4040)
                .setDescription(`**${member.user.username}** (\`${member.id}\`) left.`);
            await channel.send({ embeds: [embed] });
        } catch (e) {
            log("Failed to log user leaving", e);
        };
    });
    client.on(Events.InteractionCreate, async interaction => {
        try {
            if (!interaction.isButton()) return;
            const role = interaction.customId;
            if (!config.roles[role]) return;
            const [roleId, _] = config.roles[role];
            const member = interaction.member;
            if (member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId, "requested");
                const embed = new EmbedBuilder()
                    .setColor(0xff4040)
                    .setDescription(`<@&${roleId}> removed!`);
                await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
            } else {
                await member.roles.add(roleId, "requested");
                const embed = new EmbedBuilder()
                    .setColor(0x40ff40)
                    .setDescription(`<@&${roleId}> added!`);
                await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
            };
        } catch (e) {
            log("Failed to add/remove role", e);
        };
    });
    return client;
};