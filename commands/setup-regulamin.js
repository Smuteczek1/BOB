const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../db');
const {
  buildIntroEmbed,
  buildRulePointEmbed,
  buildRulePointButtonRow,
  buildFinalVerifyEmbed,
  formatEmojiForReact,
} = require('../utils/verification');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-regulamin')
    .setDescription('Konfiguruje regulamin serwera z weryfikacją przez reakcję.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('ustaw')
      .setDescription('Ustawia kanał, rolę weryfikacyjną, emotkę i wstęp do regulaminu.')
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
        .setName('emotka')
        .setDescription('Emotka do weryfikacji (domyślnie ✅). Możesz wkleić emotkę z serwera.')
        .setRequired(false))
      .addStringOption(opt => opt
        .setName('wstep')
        .setDescription('Tekst wstępu przed listą punktów (użyj \\n dla nowej linii). Opcjonalne.')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('publikuj')
      .setDescription('Publikuje/odświeża cały regulamin na kanale (wstęp + punkty + weryfikacja).'))
    .addSubcommand(sub => sub
      .setName('podglad')
      .setDescription('Pokazuje lokalny podgląd całego regulaminu (widoczny tylko dla Ciebie).'))
    .addSubcommand(sub => sub
      .setName('usun')
      .setDescription('Usuwa opublikowany regulamin z kanału (definicje punktów zostają zachowane).')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'ustaw') {
      const channel = interaction.options.getChannel('kanal');
      const role = interaction.options.getRole('rola');
      const emoji = interaction.options.getString('emotka');
      const rawWstep = interaction.options.getString('wstep');
      const wstep = rawWstep ? rawWstep.replaceAll('\\n', '\n') : undefined;

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

      await db.setVerificationConfig(guildId, {
        channelId: channel.id,
        roleId: role.id,
        rulesText: wstep,
        emoji: emoji ?? undefined,
      });

      await interaction.reply({
        content:
          `✅ Skonfigurowano regulamin!\n` +
          `📍 Kanał: <#${channel.id}>\n` +
          `🎭 Rola po weryfikacji: <@&${role.id}>\n` +
          `${emoji || '✅'} Emotka weryfikująca: ${emoji || '✅'}\n\n` +
          `Teraz dodaj punkty regulaminu przez \`/regulamin-punkt dodaj\`, a na końcu użyj \`/setup-regulamin publikuj\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'publikuj') {
      const config = await db.getGuildConfig(guildId);
      if (!config || !config.verify_channel_id || !config.verify_role_id) {
        await interaction.reply({
          content: '⚠️ Najpierw skonfiguruj kanał i rolę przez `/setup-regulamin ustaw`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const points = await db.getRulePoints(guildId);
      if (!points || points.length === 0) {
        await interaction.reply({
          content: '⚠️ Nie masz jeszcze żadnych punktów regulaminu — dodaj je przez `/regulamin-punkt dodaj`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const channel = await interaction.guild.channels.fetch(config.verify_channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.editReply({ content: '❌ Nie mogę znaleźć skonfigurowanego kanału — sprawdź `/setup-regulamin ustaw`.' });
        return;
      }

      // Usuwamy stare wiadomości (jeśli istniały). WAŻNE: role już nadane wcześniej NIE znikają -
      // są przypisane do użytkownika, a nie do wiadomości z reakcją.
      const oldMessageIds = [
        config.verify_intro_message_id,
        ...points.map(p => p.message_id),
        config.verify_message_id,
      ].filter(Boolean);

      for (const msgId of oldMessageIds) {
        const msg = await channel.messages.fetch(msgId).catch(() => null);
        if (msg) await msg.delete().catch(() => null);
      }

      // 1. Wstęp
      const introEmbed = buildIntroEmbed(interaction.guild, config);
      const introMessage = await channel.send({ embeds: [introEmbed] });

      // 2. Punkty regulaminu - każdy jako osobna wiadomość
      for (let i = 0; i < points.length; i++) {
        const point = points[i];
        const embed = buildRulePointEmbed(point, i + 1, points.length);
        const row = buildRulePointButtonRow(point);
        const sent = await channel.send({ embeds: [embed], components: row ? [row] : [] });
        await db.setRulePointMessageId(point.id, sent.id);
      }

      // 3. Wiadomość weryfikacyjna z reakcją (bot sam reaguje jako pierwszy, dla wygody)
      const verifyEmbed = buildFinalVerifyEmbed(interaction.guild, config);
      const verifyMessage = await channel.send({ embeds: [verifyEmbed] });
      await verifyMessage.react(formatEmojiForReact(config.verify_emoji)).catch(err =>
        console.error('Nie udało się dodać reakcji bota (sprawdź czy emotka jest poprawna/bot ma do niej dostęp):', err)
      );

      await db.setVerificationMessageIds(guildId, {
        introMessageId: introMessage.id,
        verifyMessageId: verifyMessage.id,
      });

      await interaction.editReply({
        content:
          `✅ Opublikowano regulamin na <#${channel.id}>!\n` +
          `📄 Punktów: **${points.length}**\n` +
          `${config.verify_emoji || '✅'} Rola po weryfikacji: <@&${config.verify_role_id}>`,
      });
      return;
    }

    if (sub === 'podglad') {
      const config = await db.getGuildConfig(guildId);
      const points = await db.getRulePoints(guildId);

      const embeds = [buildIntroEmbed(interaction.guild, config)];
      points.forEach((p, i) => embeds.push(buildRulePointEmbed(p, i + 1, points.length)));
      embeds.push(buildFinalVerifyEmbed(interaction.guild, config));

      // Discord pozwala na maksymalnie 10 embedów w jednej wiadomości
      await interaction.reply({ embeds: embeds.slice(0, 10), flags: MessageFlags.Ephemeral });

      if (embeds.length > 10) {
        await interaction.followUp({
          content: `ℹ️ Podgląd pokazuje tylko pierwsze 10 z ${embeds.length} elementów (limit Discorda w jednej wiadomości). Cały regulamin zobaczysz po publikacji.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (sub === 'usun') {
      const config = await db.getGuildConfig(guildId);
      const points = await db.getRulePoints(guildId);

      if (config?.verify_channel_id) {
        const channel = await interaction.guild.channels.fetch(config.verify_channel_id).catch(() => null);
        if (channel) {
          const idsToDelete = [
            config.verify_intro_message_id,
            ...points.map(p => p.message_id),
            config.verify_message_id,
          ].filter(Boolean);

          for (const msgId of idsToDelete) {
            const msg = await channel.messages.fetch(msgId).catch(() => null);
            if (msg) await msg.delete().catch(() => null);
          }
        }
      }

      await db.clearRulePointMessageIds(guildId);
      await db.setVerificationMessageIds(guildId, { introMessageId: null, verifyMessageId: null });

      await interaction.reply({
        content:
          '✅ Usunięto opublikowany regulamin z kanału.\n' +
          'ℹ️ Definicje punktów zostały zachowane — możesz opublikować ponownie przez `/setup-regulamin publikuj`.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
