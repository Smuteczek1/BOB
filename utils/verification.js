const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} = require('discord.js');
const db = require('../db');
const { parseEmojiInput } = require('./rolePanels');

const RULE_EXPAND_PREFIX = 'rule_expand_';
const RULE_PRIVATE_OPEN_ID = 'rule_private_open';
const RULE_PRIVATE_SELECT_ID = 'rule_private_select';

const DEFAULT_RULES_TEXT =
  'Administracja nie ustawiła jeszcze wstępu do regulaminu.\n' +
  'Użyj `/setup-regulamin ustaw` z opcją `wstep`, aby go dodać.';

// Format akceptowany przez message.react()
function formatEmojiForReact(raw) {
  const parsed = parseEmojiInput(raw || '✅');
  return parsed.id ? `${parsed.name}:${parsed.id}` : parsed.name;
}

function buildIntroEmbed(guild, config) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📜 Regulamin serwera')
    .setDescription(config?.verify_rules_text || DEFAULT_RULES_TEXT)
    .setThumbnail(guild.iconURL({ size: 256 }) ?? null);
}

function buildRulePointEmbed(point, index, total) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${index}. ${point.title}`)
    .setDescription(point.summary)
    .setFooter({ text: `Punkt regulaminu ${index}/${total}` });
}

// Zwraca ActionRow z przyciskiem "Rozwiń" TYLKO jeśli punkt ma dodatkowy opis - w przeciwnym
// razie zwraca null, żeby nie pokazywać pustego/bezużytecznego przycisku.
function buildRulePointButtonRow(point) {
  if (!point.details) return null;

  const button = new ButtonBuilder()
    .setCustomId(`${RULE_EXPAND_PREFIX}${point.id}`)
    .setLabel('Rozwiń')
    .setEmoji('🔽')
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(button);
}

function buildFinalVerifyEmbed(guild, config) {
  const emoji = config?.verify_emoji || '✅';
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Akceptacja regulaminu')
    .setDescription(
      `Przeczytałeś/aś powyższy regulamin?\n\n` +
      `Zareaguj poniżej emotką ${emoji}, aby go zaakceptować i uzyskać dostęp do serwera.`
    )
    .setFooter({ text: 'Usunięcie reakcji NIE zabiera roli - to jednorazowa akceptacja.' });
}

// Przycisk "Mój prywatny widok" - wysyłany na wiadomości ze wstępem regulaminu
function buildPrivateViewButtonRow() {
  const button = new ButtonBuilder()
    .setCustomId(RULE_PRIVATE_OPEN_ID)
    .setLabel('Mój prywatny widok')
    .setEmoji('🔒')
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder().addComponents(button);
}

// Skrócona lista wszystkich punktów naraz - widok domyślny prywatnego podglądu
function buildPrivateListEmbed(guild, points, config) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📜 Regulamin serwera — Twój prywatny podgląd')
    .setDescription(
      (config?.verify_rules_text ? `${config.verify_rules_text}\n\n` : '') +
      points.map((p, i) => `**${i + 1}. ${p.title}**\n${p.summary}`).join('\n\n')
    )
    .setThumbnail(guild.iconURL({ size: 256 }) ?? null)
    .setFooter({ text: 'Wybierz punkt z listy poniżej, aby zobaczyć jego pełne rozwinięcie.' });
}

// Select menu do wyboru punktu w prywatnym widoku - wybór EDYTUJE tę samą wiadomość
// (interaction.update()), zamiast tworzyć nowe efemeryczne odpowiedzi.
function buildPrivateSelectRow(points, selectedId) {
  const options = [
    new StringSelectMenuOptionBuilder()
      .setLabel('📋 Pokaż pełną listę')
      .setValue('ALL')
      .setDefault(selectedId === null),
    ...points.slice(0, 24).map((p, idx) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${idx + 1}. ${p.title}`.slice(0, 100))
        .setValue(String(p.id))
        .setDefault(String(p.id) === selectedId),
    ),
  ];

  const select = new StringSelectMenuBuilder()
    .setCustomId(RULE_PRIVATE_SELECT_ID)
    .setPlaceholder('Wybierz punkt do rozwinięcia...')
    .addOptions(options);

  return new ActionRowBuilder().addComponents(select);
}

// Kliknięcie "Mój prywatny widok" - pierwsza (i jedyna) odpowiedź, ephemeral.
async function handleOpenPrivateView(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);

  if (!points || points.length === 0) {
    await interaction.reply({
      content: 'ℹ️ Regulamin nie ma jeszcze żadnych punktów.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = buildPrivateListEmbed(interaction.guild, points, config);
  const row = buildPrivateSelectRow(points, null);

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

// Wybór punktu z select menu w prywatnym widoku - EDYTUJE istniejącą wiadomość zamiast
// wysyłać nową, żeby nie zaśmiecać czatu kolejnymi odpowiedziami.
async function handlePrivateSelect(interaction) {
  const guildId = interaction.guild.id;
  const points = await db.getRulePoints(guildId);
  const value = interaction.values[0];

  if (value === 'ALL') {
    const config = await db.getGuildConfig(guildId);
    const embed = buildPrivateListEmbed(interaction.guild, points, config);
    const row = buildPrivateSelectRow(points, null);
    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }

  const point = points.find(p => String(p.id) === value);
  const row = buildPrivateSelectRow(points, value);

  if (!point) {
    await interaction.update({
      content: '⚠️ Ten punkt już nie istnieje (mógł zostać usunięty).',
      embeds: [],
      components: [row],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📖 ${point.title}`)
    .setDescription(point.details || point.summary);

  await interaction.update({ content: null, embeds: [embed], components: [row] });
}

// Kliknięcie przycisku "Rozwiń" pod konkretnym punktem regulaminu - pokazuje pełną,
// rozwiniętą treść tylko osobie, która kliknęła (ephemeral).
async function handleRuleExpandClick(interaction) {
  const id = interaction.customId.slice(RULE_EXPAND_PREFIX.length);
  const point = await db.getRulePoint(id);

  if (!point) {
    await interaction.reply({
      content: '⚠️ Ten punkt regulaminu już nie istnieje (mógł zostać usunięty/edytowany).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📖 ${point.title}`)
    .setDescription(point.details || point.summary);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// Obsługa reakcji na wiadomości weryfikacyjnej - nadaje rolę i (opcjonalnie) zdejmuje
// rolę startową, jeśli tak skonfigurowano w /rola-startowa.
async function handleVerifyReaction(reaction, user) {
  if (user.bot) return;

  if (reaction.partial) {
    reaction = await reaction.fetch().catch(() => null);
    if (!reaction) return;
  }
  if (reaction.message.partial) {
    await reaction.message.fetch().catch(() => null);
  }

  const guild = reaction.message.guild;
  if (!guild) return;

  const config = await db.getGuildConfig(guild.id);
  if (!config || !config.verify_message_id || reaction.message.id !== config.verify_message_id) return;
  if (!config.verify_role_id) return;

  const configuredEmoji = parseEmojiInput(config.verify_emoji || '✅');
  const reactionKey = reaction.emoji.id ?? reaction.emoji.name;
  if (reactionKey !== configuredEmoji.key) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  const role = await guild.roles.fetch(config.verify_role_id).catch(() => null);
  if (!role) return;

  if (member.roles.cache.has(role.id)) return; // już zweryfikowany/a

  try {
    await member.roles.add(role);

    if (
      config.starter_role_id &&
      config.starter_role_replace_on_verify &&
      member.roles.cache.has(config.starter_role_id)
    ) {
      await member.roles.remove(config.starter_role_id).catch(err =>
        console.error('Nie udało się zdjąć roli startowej po weryfikacji:', err)
      );
    }
  } catch (err) {
    console.error('Błąd podczas nadawania roli przy weryfikacji (reakcja):', err);
  }
}

module.exports = {
  RULE_EXPAND_PREFIX,
  RULE_PRIVATE_OPEN_ID,
  RULE_PRIVATE_SELECT_ID,
  DEFAULT_RULES_TEXT,
  formatEmojiForReact,
  buildIntroEmbed,
  buildRulePointEmbed,
  buildRulePointButtonRow,
  buildFinalVerifyEmbed,
  buildPrivateViewButtonRow,
  buildPrivateListEmbed,
  buildPrivateSelectRow,
  handleOpenPrivateView,
  handlePrivateSelect,
  handleRuleExpandClick,
  handleVerifyReaction,
};
