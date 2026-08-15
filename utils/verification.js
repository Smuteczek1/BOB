const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const db = require('../db');

const VERIFY_BUTTON_PREFIX = 'verify_accept_';

const DEFAULT_RULES_TEXT =
  'Administracja nie ustawiła jeszcze treści regulaminu.\n' +
  'Użyj `/setup-regulamin ustaw` z opcją `tresc`, aby ją dodać.';

function buildRulesEmbed(guild, config) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📜 Regulamin serwera')
    .setDescription(config?.verify_rules_text || DEFAULT_RULES_TEXT)
    .setThumbnail(guild.iconURL({ size: 256 }) ?? null)
    .setFooter({ text: 'Kliknij przycisk poniżej, aby zaakceptować regulamin i uzyskać dostęp do serwera.' });
}

function buildVerifyButtonRow(guildId) {
  const button = new ButtonBuilder()
    .setCustomId(`${VERIFY_BUTTON_PREFIX}${guildId}`)
    .setLabel('Akceptuję regulamin')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success);

  return new ActionRowBuilder().addComponents(button);
}

// Obsługa kliknięcia przycisku "Akceptuję regulamin" - nadaje rolę weryfikacji
// i (opcjonalnie) zdejmuje rolę startową, jeśli tak skonfigurowano w /rola-startowa.
async function handleVerifyButtonClick(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);

  if (!config || !config.verify_role_id) {
    await interaction.reply({
      content: '⚠️ Weryfikacja nie jest obecnie skonfigurowana na tym serwerze.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const member = interaction.member;
  const role = await interaction.guild.roles.fetch(config.verify_role_id).catch(() => null);

  if (!role) {
    await interaction.reply({
      content: '⚠️ Rola weryfikacji już nie istnieje na serwerze - skontaktuj się z administracją.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (member.roles.cache.has(role.id)) {
    await interaction.reply({
      content: '✅ Jesteś już zweryfikowany/a!',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  try {
    await member.roles.add(role);

    // Jeśli rola startowa ma być zastępowana przy weryfikacji - zdejmujemy ją
    if (
      config.starter_role_id &&
      config.starter_role_replace_on_verify &&
      member.roles.cache.has(config.starter_role_id)
    ) {
      await member.roles.remove(config.starter_role_id).catch(err =>
        console.error('Nie udało się zdjąć roli startowej po weryfikacji:', err)
      );
    }

    await interaction.reply({
      content: `✅ Zweryfikowano! Nadano rolę **${role.name}**. Witaj na serwerze! 🎉`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    console.error('Błąd podczas nadawania roli przy weryfikacji:', err);
    await interaction.reply({
      content:
        '❌ Nie udało się nadać roli. Upewnij się, że rola bota znajduje się **WYŻEJ** ' +
        'w hierarchii serwera niż rola weryfikacji.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return true;
}

module.exports = {
  VERIFY_BUTTON_PREFIX,
  DEFAULT_RULES_TEXT,
  buildRulesEmbed,
  buildVerifyButtonRow,
  handleVerifyButtonClick,
};
