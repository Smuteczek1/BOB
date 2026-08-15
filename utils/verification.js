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

const RULE_PRIVATE_OPEN_ID = 'rule_private_open';
const RULE_PRIVATE_EXPAND_PREFIX = 'rule_private_expand_';
const RULE_PRIVATE_PAGE_PREFIX = 'rule_private_page_';
const RULE_ACCEPT_ID = 'rule_accept';

// Ile punktów regulaminu pokazujemy na jednej "stronie" prywatnego widoku.
// Discord (Components V2) pozwala na max 40 komponentów w jednej wiadomości,
// a każdy punkt z "doprecyzowaniem" zajmuje kilka komponentów (Section + TextDisplay
// + Button + Separator), więc trzeba dzielić długi regulamin na strony.
const PAGE_SIZE = 5;

// Flaga wymagana dla KAŻDEJ wiadomości używającej Components V2 (Container/Section/TextDisplay/...)
const V2_FLAGS = MessageFlags.IsComponentsV2;

// --- Okno 1: publiczne "wejście" do regulaminu (jedyna wiadomość widoczna na kanale) ---
const DEFAULT_RULES_TITLE = '📜 Regulamin serwera';
const DEFAULT_RULES_TEXT =
  'Zanim zaczniesz korzystać z serwera, zapoznaj się z poniższymi zasadami.\n' +
  'Kliknij przycisk poniżej, aby otworzyć swój prywatny widok regulaminu — ' +
  'na dole znajdziesz przycisk do akceptacji.';
const DEFAULT_BUTTON_LABEL = 'Sprawdź regulamin';
const DEFAULT_INTRO_COMMENT = '-# Widok otworzy się tylko dla Ciebie — nikt inny go nie zobaczy.';

// --- Okno 2: sekcja akceptacji na DOLE prywatnego widoku (pokazywana na ostatniej stronie) ---
const DEFAULT_ACCEPT_TITLE = 'Akceptacja regulaminu';
const DEFAULT_ACCEPT_TEXT =
  'Przeczytałeś/aś wszystkie punkty powyżej? Kliknij przycisk poniżej, aby zaakceptować ' +
  'regulamin i uzyskać dostęp do serwera.';
const DEFAULT_ACCEPT_BUTTON_LABEL = 'Akceptuję regulamin';
const DEFAULT_ACCEPT_COMMENT = '-# Klikając, potwierdzasz że zapoznałeś/aś się z powyższymi zasadami.';

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

// Trzyma stan "na której stronie regulaminu jest dana wiadomość".
// Klucz: ID wiadomości -> numer strony (od 0). Tak samo jak wyżej — tylko stan UI.
const pageByMessage = new Map();

function getCurrentPage(messageId) {
  return pageByMessage.get(messageId) ?? 0;
}

function memberHasVerifiedRole(member, config) {
  if (!member || !config?.verify_role_id) return false;
  return member.roles.cache.has(config.verify_role_id);
}

// --- Publiczna wiadomość: Tytuł -> Tekst -> [Przycisk] -> Komentarz ---
function buildIntroContainer(guild, config) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  const title = config?.verify_rules_title || DEFAULT_RULES_TITLE;
  const description = config?.verify_rules_text || DEFAULT_RULES_TEXT;
  const buttonLabel = (config?.verify_button_label || DEFAULT_BUTTON_LABEL).slice(0, 80);
  const comment = config?.verify_intro_comment || DEFAULT_INTRO_COMMENT;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`),
    new TextDisplayBuilder().setContent(description),
  );

  const button = new ButtonBuilder()
    .setCustomId(RULE_PRIVATE_OPEN_ID)
    .setLabel(buttonLabel)
    .setStyle(ButtonStyle.Primary);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(button));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(comment));

  return container;
}

// --- Prywatny widok (ephemeral): regulamin podzielony na strony (akordeon na punkty)
// + sekcja akceptacji na dole OSTATNIEJ strony. Rozwinięte punkty (ID w `expandedIds`)
// pokazują doprecyzowanie TUŻ POD swoim podsumowaniem, reszta listy zostaje bez zmian.
function buildRegulaminContainer(
  guild,
  points,
  config,
  expandedIds = new Set(),
  alreadyVerified = false,
  page = 0,
) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  const totalPages = Math.max(1, Math.ceil(points.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  const title = config?.verify_rules_title || DEFAULT_RULES_TITLE;
  const description = config?.verify_rules_text || DEFAULT_RULES_TEXT;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${title}${totalPages > 1 ? ` (strona ${safePage + 1}/${totalPages})` : ''}`,
    ),
  );

  // Opis regulaminu pokazujemy tylko na pierwszej stronie, żeby oszczędzić komponenty.
  if (safePage === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(description));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const startIndex = safePage * PAGE_SIZE;
  const pagePoints = points.slice(startIndex, startIndex + PAGE_SIZE);

  pagePoints.forEach((p, i) => {
    const globalIndex = startIndex + i;
    const isExpanded = expandedIds.has(String(p.id));
    let content = `### ${globalIndex + 1}. ${p.title}\n${p.summary}`;
    if (isExpanded && p.details) {
      content += `\n\n> 📖 **Doprecyzowanie:**\n> ${p.details.replaceAll('\n', '\n> ')}`;
    }

    const textDisplay = new TextDisplayBuilder().setContent(content);

    if (p.details) {
      const expandButton = new ButtonBuilder()
        .setCustomId(`${RULE_PRIVATE_EXPAND_PREFIX}${p.id}`)
        .setLabel(isExpanded ? 'Zwiń' : 'Rozwiń')
        .setEmoji(isExpanded ? '🔼' : '🔽')
        .setStyle(isExpanded ? ButtonStyle.Primary : ButtonStyle.Secondary);

      container.addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(textDisplay).setButtonAccessory(expandButton),
      );
    } else {
      container.addTextDisplayComponents(textDisplay);
    }

    if (i < pagePoints.length - 1) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
    }
  });

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));

  // --- Nawigacja stron (tylko jeśli jest więcej niż jedna strona) ---
  if (totalPages > 1) {
    const prevButton = new ButtonBuilder()
      .setCustomId(`${RULE_PRIVATE_PAGE_PREFIX}${safePage - 1}`)
      .setLabel('◀ Poprzednia')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0);

    const nextButton = new ButtonBuilder()
      .setCustomId(`${RULE_PRIVATE_PAGE_PREFIX}${safePage + 1}`)
      .setLabel('Następna ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === totalPages - 1);

    container.addActionRowComponents(new ActionRowBuilder().addComponents(prevButton, nextButton));
  }

  // --- Sekcja akceptacji: tylko na ostatniej stronie ---
  if (safePage === totalPages - 1) {
    const acceptTitle = config?.verify_accept_title || DEFAULT_ACCEPT_TITLE;
    const acceptText = config?.verify_accept_text || DEFAULT_ACCEPT_TEXT;
    const acceptButtonLabel = (config?.verify_accept_button_label || DEFAULT_ACCEPT_BUTTON_LABEL).slice(0, 80);
    const acceptComment = config?.verify_accept_comment || DEFAULT_ACCEPT_COMMENT;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${acceptTitle}`),
      new TextDisplayBuilder().setContent(acceptText),
    );

    if (alreadyVerified) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('-# ✅ Regulamin zaakceptowany — masz już dostęp do serwera.'),
      );
    } else {
      const acceptButton = new ButtonBuilder()
        .setCustomId(RULE_ACCEPT_ID)
        .setLabel(acceptButtonLabel)
        .setStyle(ButtonStyle.Success);

      container.addActionRowComponents(new ActionRowBuilder().addComponents(acceptButton));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(acceptComment));
    }
  }

  return container;
}

// Kliknięcie "Sprawdź regulamin" na publicznej wiadomości - pierwsza (i jedyna) odpowiedź, ephemeral.
async function handleOpenPrivateView(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);

  if (!points || points.length === 0) {
    await interaction.reply({ content: 'ℹ️ Regulamin nie ma jeszcze żadnych punktów.', flags: MessageFlags.Ephemeral });
    return;
  }

  const alreadyVerified = memberHasVerifiedRole(interaction.member, config);
  const container = buildRegulaminContainer(interaction.guild, points, config, new Set(), alreadyVerified, 0);

  await interaction.reply({
    components: [container],
    flags: MessageFlags.Ephemeral | V2_FLAGS,
  });
}

// Kliknięcie "Rozwiń"/"Zwiń" PRZY KONKRETNYM punkcie - dopisuje (lub chowa) doprecyzowanie
// TEGO punktu w miejscu, edytując tę samą wiadomość (interaction.update()), bez ruszania reszty.
async function handlePrivateExpandClick(interaction) {
  const id = interaction.customId.slice(RULE_PRIVATE_EXPAND_PREFIX.length);
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);
  const expanded = getExpandedSet(interaction.message.id);
  const page = getCurrentPage(interaction.message.id);

  if (expanded.has(id)) {
    expanded.delete(id);
  } else {
    expanded.add(id);
  }

  const alreadyVerified = memberHasVerifiedRole(interaction.member, config);
  const container = buildRegulaminContainer(interaction.guild, points, config, expanded, alreadyVerified, page);

  await interaction.update({ components: [container], flags: V2_FLAGS });
}

// Kliknięcie "Poprzednia"/"Następna" - zmienia stronę widoku, edytując tę samą wiadomość.
async function handlePrivatePageChange(interaction) {
  const requestedPage = parseInt(interaction.customId.slice(RULE_PRIVATE_PAGE_PREFIX.length), 10);
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);
  const expanded = getExpandedSet(interaction.message.id);

  const totalPages = Math.max(1, Math.ceil(points.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number.isNaN(requestedPage) ? 0 : requestedPage), totalPages - 1);
  pageByMessage.set(interaction.message.id, safePage);

  const alreadyVerified = memberHasVerifiedRole(interaction.member, config);
  const container = buildRegulaminContainer(interaction.guild, points, config, expanded, alreadyVerified, safePage);

  await interaction.update({ components: [container], flags: V2_FLAGS });
}

// Kliknięcie przycisku akceptacji na DOLE prywatnego widoku - nadaje rolę (jeśli jeszcze
// nie ma) i przebudowuje tę samą wiadomość, zamieniając przycisk na potwierdzenie.
async function handleAcceptClick(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);

  if (!config?.verify_role_id) {
    await interaction.reply({
      content: '⚠️ Administracja nie skonfigurowała jeszcze roli nadawanej po akceptacji (`/setup-regulamin ustaw`).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const role = await interaction.guild.roles.fetch(config.verify_role_id).catch(() => null);
  if (!role) {
    await interaction.reply({
      content: '⚠️ Skonfigurowana rola weryfikacyjna już nie istnieje na serwerze — zgłoś to administracji.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member;
  if (!member.roles.cache.has(role.id)) {
    try {
      await member.roles.add(role);
      if (
        config.starter_role_id &&
        config.starter_role_replace_on_verify &&
        member.roles.cache.has(config.starter_role_id)
      ) {
        await member.roles.remove(config.starter_role_id).catch(err =>
          console.error('Nie udało się zdjąć roli startowej po akceptacji regulaminu:', err)
        );
      }
    } catch (err) {
      console.error('Błąd podczas nadawania roli przy akceptacji regulaminu (przycisk):', err);
      await interaction.reply({
        content:
          '❌ Nie udało się nadać roli. Sprawdź, czy rola bota jest **wyżej** niż rola weryfikacyjna ' +
          '(Ustawienia serwera -> Role) i czy bot ma uprawnienie **Zarządzaj rolami**.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const points = await db.getRulePoints(guildId);
  const expanded = getExpandedSet(interaction.message.id);
  const page = getCurrentPage(interaction.message.id);
  const container = buildRegulaminContainer(interaction.guild, points, config, expanded, true, page);

  await interaction.update({ components: [container], flags: V2_FLAGS });
}

module.exports = {
  RULE_PRIVATE_OPEN_ID,
  RULE_PRIVATE_EXPAND_PREFIX,
  RULE_PRIVATE_PAGE_PREFIX,
  RULE_ACCEPT_ID,
  V2_FLAGS,
  PAGE_SIZE,
  DEFAULT_RULES_TITLE,
  DEFAULT_RULES_TEXT,
  DEFAULT_BUTTON_LABEL,
  DEFAULT_INTRO_COMMENT,
  DEFAULT_ACCEPT_TITLE,
  DEFAULT_ACCEPT_TEXT,
  DEFAULT_ACCEPT_BUTTON_LABEL,
  DEFAULT_ACCEPT_COMMENT,
  buildIntroContainer,
  buildRegulaminContainer,
  handleOpenPrivateView,
  handlePrivateExpandClick,
  handlePrivatePageChange,
  handleAcceptClick,
};
