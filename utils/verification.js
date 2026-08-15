const {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
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

// Flaga wymagana dla KAŻDEJ wiadomości używającej Components V2 (Container/Section/TextDisplay/...)
const V2_FLAGS = MessageFlags.IsComponentsV2;

const DEFAULT_RULES_TITLE = '📜 Regulamin serwera';
const DEFAULT_RULES_TEXT =
  'Zanim zaczniesz korzystać z serwera, zapoznaj się z poniższymi zasadami.\n' +
  'Kliknij przycisk poniżej, aby otworzyć swój prywatny, wygodny widok regulaminu — ' +
  'każdy punkt możesz rozwinąć, jeśli potrzebujesz doprecyzowania.';
const DEFAULT_BUTTON_LABEL = 'Sprawdź regulamin';

// Trzyma stan "które punkty są rozwinięte" dla każdej prywatnej (ephemeral) wiadomości.
// Klucz: ID wiadomości -> Set ID punktów aktualnie rozwiniętych. Żyje tylko na czas
// działania procesu bota (to tylko UI-owy stan podglądu, nic nie trzeba tu trwale zapisywać).
const expandedPointsByMessage = new Map();

function getExpandedSet(messageId) {
  if (!expandedPointsByMessage.has(messageId)) {
    expandedPointsByMessage.set(messageId, new Set());
  }
  return expandedPointsByMessage.get(messageId);
}

// Format akceptowany przez message.react()
function formatEmojiForReact(raw) {
  const parsed = parseEmojiInput(raw || '✅');
  return parsed.id ? `${parsed.name}:${parsed.id}` : parsed.name;
}

// --- Wiadomość ze wstępem (publikowana na kanale) ---
function buildIntroContainer(guild, config) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  const title = config?.verify_rules_title || DEFAULT_RULES_TITLE;
  const description = config?.verify_rules_text || DEFAULT_RULES_TEXT;
  const buttonLabel = config?.verify_button_label || DEFAULT_BUTTON_LABEL;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`),
    new TextDisplayBuilder().setContent(description),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const button = new ButtonBuilder()
    .setCustomId(RULE_PRIVATE_OPEN_ID)
    .setLabel(buttonLabel)
    .setEmoji('📖')
    .setStyle(ButtonStyle.Primary);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(button));

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('-# Widok otworzy się tylko dla Ciebie i nikt inny go nie zobaczy.'),
  );

  return container;
}

// --- Pojedynczy punkt regulaminu (publikowany jako osobna wiadomość na kanale) ---
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

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# Punkt ${index} z ${total}`),
  );

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

// --- Prywatny widok: lista wszystkich punktów w formie akordeonu.
// Rozwinięte punkty (ID w `expandedIds`) pokazują dodatkową linię z doprecyzowaniem
// TUŻ POD swoim podsumowaniem, a reszta listy pozostaje nietknięta.
function buildPrivateListContainer(guild, points, config, expandedIds = new Set()) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  const title = config?.verify_rules_title || DEFAULT_RULES_TITLE;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title} — Twój prywatny podgląd`),
  );

  if (config?.verify_rules_text) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(config.verify_rules_text));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  points.forEach((p, i) => {
    const isExpanded = expandedIds.has(String(p.id));
    let content = `### ${i + 1}. ${p.title}\n${p.summary}`;

    if (isExpanded && p.details) {
      content += `\n\n> 📖 **Doprecyzowanie:**\n> ${p.details.replaceAll('\n', '\n> ')}`;
    }

    const textDisplay = new TextDisplayBuilder().setContent(content);

    if (p.details) {
      const button = new ButtonBuilder()
        .setCustomId(`${RULE_PRIVATE_EXPAND_PREFIX}${p.id}`)
        .setLabel(isExpanded ? 'Zwiń' : 'Rozwiń')
        .setEmoji(isExpanded ? '🔼' : '🔽')
        .setStyle(isExpanded ? ButtonStyle.Primary : ButtonStyle.Secondary);

      container.addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(textDisplay).setButtonAccessory(button),
      );
    } else {
      container.addTextDisplayComponents(textDisplay);
    }

    if (i < points.length - 1) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
    }
  });

  return container;
}

// Kliknięcie "Sprawdź regulamin" na wstępie - pierwsza (i jedyna) odpowiedź, ephemeral.
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

// Kliknięcie "Rozwiń"/"Zwiń" PRZY KONKRETNYM punkcie w prywatnym widoku - dopisuje (lub chowa)
// doprecyzowanie TEGO punktu w miejscu, edytując tę samą wiadomość (interaction.update()),
// bez usuwania czy zwijania reszty listy.
async function handlePrivateExpandClick(interaction) {
  const id = interaction.customId.slice(RULE_PRIVATE_EXPAND_PREFIX.length);
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);

  const expanded = getExpandedSet(interaction.message.id);
  if (expanded.has(id)) {
    expanded.delete(id);
  } else {
    expanded.add(id);
  }

  const container = buildPrivateListContainer(interaction.guild, points, config, expanded);
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
  V2_FLAGS,
  DEFAULT_RULES_TITLE,
  DEFAULT_RULES_TEXT,
  DEFAULT_BUTTON_LABEL,
  formatEmojiForReact,
  buildIntroContainer,
  buildRulePointContainer,
  buildFinalVerifyContainer,
  buildPrivateListContainer,
  handleOpenPrivateView,
  handlePrivateExpandClick,
  handleRuleExpandClick,
  handleVerifyReaction,
};
