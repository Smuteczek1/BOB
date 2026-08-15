const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../db');
const { buildRulesEmbed, buildVerifyButtonRow } = require('../utils/verification');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-regulamin')
    .setDescription('Konfiguruje panel regulaminu z przyciskiem weryfikacji.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('ustaw')
      .setDescription('Tworzy/aktualizuje panel regulaminu z przyciskiem weryfikacji.')
      .addChannelOption(opt => opt
        .setName('kanal')
        .setDescription('Kanał, na którym ma pojawić się regulamin')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
      .addRoleOption(opt => opt
        .setName('rola')
        .setDescription('Rola nadawana po zaakceptowaniu regulaminu (np. Zweryfikowany)')
        .setRequired(true))
      .addStringOption(opt => opt
        .setName('tresc')
        .setDescription('Treść regulaminu (użyj \\n dla nowej linii). Puste = uzupełnisz później.')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('podglad')
      .setDescription('Pokazuje podgląd aktualnego regulaminu.'))
    .addSubcommand(sub => sub
      .setName('usun')
      .setDescription('Usuwa panel regulaminu z kanału i wyłącza weryfikację.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'ustaw') {
      const channel = interaction.options.getChannel('kanal');
      const role = interaction.options.getRole('rola');
      const rawText = interaction.options.getString('tresc');
      const text = rawText ? rawText.replaceAll('\\n', '\n') : null;

      if (role.managed) {
        await interaction.reply({
          content: '❌ Nie można ustawić jako roli weryfikacyjnej roli zarządzanej przez integrację/bota.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const botMember = interaction.guild.members.me;
      if (botMember && role.position >= botMember.roles.highest.position) {
        await interaction.reply({
          content:
            '⚠️ Ta rola jest wyżej (lub na równi) w hierarchii niż najwyższa rola bota — ' +
            'bot **nie będzie w stanie** jej nadawać. Przesuń rolę bota wyżej na liście ról serwera.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      await db.setVerificationConfig(guildId, { channelId: channel.id, roleId: role.id, rulesText: text });
      const config = await db.getGuildConfig(guildId);

      const embed = buildRulesEmbed(interaction.guild, config);
      const row = buildVerifyButtonRow(guildId);

      // Jeśli istniała już wcześniejsza wiadomość regulaminu na tym samym kanale - edytujemy ją,
      // zamiast tworzyć duplikat. Jeśli kanał się zmienił - starą wiadomość usuwamy.
      let message = null;
      if (config.verify_message_id && config.verify_channel_id) {
        const oldChannel = await interaction.guild.channels.fetch(config.verify_channel_id).catch(() => null);
        if (oldChannel) {
          const oldMessage = await oldChannel.messages.fetch(config.verify_message_id).catch(() => null);
          if (oldMessage && oldChannel.id === channel.id) {
            message = await oldMessage.edit({ embeds: [embed], components: [row] }).catch(() => null);
          } else if (oldMessage) {
            await oldMessage.delete().catch(() => null);
          }
        }
      }

      if (!message) {
        message = await channel.send({ embeds: [embed], components: [row] });
      }

      await db.setVerificationMessageId(guildId, message.id);

      await interaction.editReply({
        content:
          `✅ Panel regulaminu gotowy na <#${channel.id}>!\n` +
          `🎭 Po akceptacji nadawana rola: <@&${role.id}>` +
          (text
            ? ''
            : '\n\n⚠️ Nie podałeś treści regulaminu — uzupełnij ją później przez `/setup-regulamin ustaw` z opcją `tresc`.'),
      });
      return;
    }

    if (sub === 'podglad') {
      const config = await db.getGuildConfig(guildId);
      const embed = buildRulesEmbed(interaction.guild, config);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'usun') {
      const config = await db.getGuildConfig(guildId);

      if (config && config.verify_channel_id && config.verify_message_id) {
        const channel = await interaction.guild.channels.fetch(config.verify_channel_id).catch(() => null);
        if (channel) {
          const message = await channel.messages.fetch(config.verify_message_id).catch(() => null);
          if (message) await message.delete().catch(() => null);
        }
      }

      await db.setVerificationConfig(guildId, { channelId: null, roleId: null, rulesText: undefined });
      await db.setVerificationMessageId(guildId, null);

      await interaction.reply({
        content: '✅ Usunięto panel regulaminu i wyłączono weryfikację.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
