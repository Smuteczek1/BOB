const {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const db = require('../db');
const { parseEmojiInput } = require('./rolePanels');

const RULE_EXPAND_PREFIX = 'rule_expand_';
const RULE_PRIVATE_OPEN_ID = 'rule_private_open';
const RULE_PRIVATE_EXPAND_PREFIX = 'rule_private_expand_';
const RULE_PRIVATE_BACK_ID = 'rule_private_back';

// Flaga wymagana dla KAŻDEJ wiadomości używającej Components V2 (Container/Section/TextDisplay/...)
const V2_FLAGS = MessageFlags.IsComponentsV2;

const DEFAULT_RULES_TEXT =
  'Administracja nie ustawiła jeszcze wstępu do regulaminu.\n' +
  'Użyj `/setup-regulamin ustaw` z opcją `wstep`, aby go dodać.';

// Format akceptowany przez message.react()
function formatEmojiForReact(raw) {
  const parsed = parseEmojiInput(raw || '✅');
  return parsed.id ? `${parsed.name}:${parsed.id}` : parsed.name;
}

// --- Wiadomość ze wstępem (publikowana na kanale) ---
function buildIntroContainer(guild, config) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 📜 Regulamin serwera'),
    new TextDisplayBuilder().setContent(config?.verify_rules_text || DEFAULT_RULES_TEXT),
  );

  container.addSeparatorComponents(new SeparatorBuilder());

  const button = new ButtonBuilder()
    .setCustomId(RULE_PRIVATE_OPEN_ID)
    .setLabel('Mój prywatny widok')
    .setEmoji('🔒')
    .setStyle(ButtonStyle.Primary);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(button));

  return container;
}

// --- Pojedynczy punkt regulaminu (publikowany jako osobna wiadomość na kanale) ---
// Tekst i przycisk "Rozwiń" leżą OBOK siebie (Section + accessory), a nie jeden pod drugim.
function buildRulePointContainer(point, index, total) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  const textDisplay = new TextDisplayBuilder().setContent(`### ${index}. ${point.title}\n${point.summary}`);

  if (point.details) {
    const button = new ButtonBuilder()
      .setCustomId(`${RULE_EXPAND_PREFIX}${point.id}`)
      .setLabel('Rozwiń')
      .setEmoji('🔽')
      .setStyle(ButtonStyle.Secondary);

    container.addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(textDisplay).setButtonAccessory(button),
    );
  } else {
    container.addTextDisplayComponents(textDisplay);
  }

  return container;
}

// --- Wiadomość weryfikacyjna z reakcją ---
function buildFinalVerifyContainer(guild, config) {
  const emoji = config?.verify_emoji || '✅';
  const container = new ContainerBuilder().setAccentColor(0x57f287);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Akceptacja regulaminu\nPrzeczytałeś/aś powyższy regulamin?\n\n` +
      `Zareaguj poniżej emotką ${emoji}, aby go zaakceptować i uzyskać dostęp do serwera.`,
    ),
  );

  return container;
}

// --- Prywatny widok: skrócona lista wszystkich punktów, każdy z przyciskiem "Rozwiń" obok tekstu ---
function buildPrivateListContainer(guild, points, config) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 📜 Regulamin — Twój prywatny podgląd'),
  );

  if (config?.verify_rules_text) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(config.verify_rules_text));
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  points.forEach((p, i) => {
    const textDisplay = new TextDisplayBuilder().setContent(`### ${i + 1}. ${p.title}\n${p.summary}`);

    if (p.details) {
      const button = new ButtonBuilder()
        .setCustomId(`${RULE_PRIVATE_EXPAND_PREFIX}${p.id}`)
        .setLabel('Rozwiń')
        .setEmoji('🔽')
        .setStyle(ButtonStyle.Secondary);

      container.addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(textDisplay).setButtonAccessory(button),
      );
    } else {
      container.addTextDisplayComponents(textDisplay);
    }
  });

  return container;
}

// --- Prywatny widok: rozwinięcie JEDNEGO konkretnego punktu + przycisk powrotu ---
function buildPrivateExpandedContainer(point) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## 📖 ${point.title}\n${point.details || point.summary}`),
  );

  container.addSeparatorComponents(new SeparatorBuilder());

  const backButton = new ButtonBuilder()
    .setCustomId(RULE_PRIVATE_BACK_ID)
    .setLabel('Wróć do listy')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(backButton));

  return container;
}

// Kliknięcie "Mój prywatny widok" na wstępie - pierwsza (i jedyna) odpowiedź, ephemeral.
async function handleOpenPrivateView(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);

  if (!points || points.length === 0) {
    await interaction.reply({ content: 'ℹ️ Regulamin nie ma jeszcze żadnych punktów.', flags: MessageFlags.Ephemeral });
    return;
  }

  const container = buildPrivateListContainer(interaction.guild, points, config);

  await interaction.reply({
    components: [container],
    flags: MessageFlags.Ephemeral | V2_FLAGS,
  });
}

// Kliknięcie "Rozwiń" PRZY KONKRETNYM punkcie w prywatnym widoku - EDYTUJE tę samą
// wiadomość (interaction.update()), zamiast tworzyć nową.
async function handlePrivateExpandClick(interaction) {
  const id = interaction.customId.slice(RULE_PRIVATE_EXPAND_PREFIX.length);
  const point = await db.getRulePoint(id);

  if (!point) {
    await interaction.update({
      components: [new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent('⚠️ Ten punkt już nie istnieje (mógł zostać usunięty).'),
      )],
      flags: V2_FLAGS,
    });
    return;
  }

  const container = buildPrivateExpandedContainer(point);
  await interaction.update({ components: [container], flags: V2_FLAGS });
}

// Kliknięcie "Wróć do listy" w prywatnym widoku - wraca do skróconej listy punktów.
async function handlePrivateBackClick(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);

  const container = buildPrivateListContainer(interaction.guild, points, config);
  await interaction.update({ components: [container], flags: V2_FLAGS });
}

// Kliknięcie przycisku "Rozwiń" pod PUBLICZNYM punktem regulaminu na kanale - pokazuje
// pełną, rozwiniętą treść tylko osobie, która kliknęła (ephemeral, bo publiczną
// wiadomość nie można edytować tylko dla jednej osoby).
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

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📖 ${point.title}\n${point.details || point.summary}`),
    );

  await interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | V2_FLAGS });
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
  RULE_PRIVATE_EXPAND_PREFIX,
  RULE_PRIVATE_BACK_ID,
  V2_FLAGS,
  DEFAULT_RULES_TEXT,
  formatEmojiForReact,
  buildIntroContainer,
  buildRulePointContainer,
  buildFinalVerifyContainer,
  buildPrivateListContainer,
  buildPrivateExpandedContainer,
  handleOpenPrivateView,
  handlePrivateExpandClick,
  handlePrivateBackClick,
  handleRuleExpandClick,
  handleVerifyReaction,
};
