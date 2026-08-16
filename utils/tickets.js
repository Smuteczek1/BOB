const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const db = require('../db');

const TICKET_TYPE_SELECT_ID = 'ticket_type_select';
const TICKET_CLOSE_BUTTON_ID = 'ticket_close';
const TICKET_CLOSE_CONFIRM_ID = 'ticket_close_confirm';
const TICKET_CLOSE_CANCEL_ID = 'ticket_close_cancel';

const V2_FLAGS = MessageFlags.IsComponentsV2;

const DEFAULT_PANEL_TITLE = '🎫 Centrum pomocy';
const DEFAULT_PANEL_TEXT =
  'Potrzebujesz pomocy albo chcesz coś zgłosić? Wybierz kategorię z listy poniżej, ' +
  'a bot utworzy dla Ciebie prywatny kanał widoczny tylko dla Ciebie i zespołu wsparcia.';
const DEFAULT_PLACEHOLDER = 'Wybierz kategorię ticketu...';

// Parsuje emoji podane przez admina w komendzie (unicode albo custom <:nazwa:id> / <a:nazwa:id>)
// i zwraca coś, co da się bezpośrednio podać do .setEmoji() w discord.js.
function parseEmojiInput(raw) {
  if (!raw) return null;
  const customMatch = raw.match(/^<(a)?:(\w+):(\d+)>$/);
  if (customMatch) {
    return { id: customMatch[3], name: customMatch[2], animated: Boolean(customMatch[1]) };
  }
  return raw.trim();
}

// Zamienia hex na liczbę do setAccentColor / setColor. Akceptuje "#FF5733" lub "FF5733".
function parseColorToInt(hex) {
  if (!hex) return 0x5865f2;
  const clean = hex.replace('#', '');
  const parsed = parseInt(clean, 16);
  return Number.isNaN(parsed) ? 0x5865f2 : parsed;
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // usuwa polskie ogonki (ą -> a, ę -> e, itd.)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ticket';
}

// --- Buduje panel wyboru kategorii ticketu (publiczna wiadomość na kanale) ---
function buildPanelContainer(config, types) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  const title = config?.ticket_panel_title || DEFAULT_PANEL_TITLE;
  const text = config?.ticket_panel_text || DEFAULT_PANEL_TEXT;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`),
    new TextDisplayBuilder().setContent(text),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  if (!types || types.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# ⚠️ Administracja nie dodała jeszcze żadnej kategorii ticketów.'),
    );
    return container;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(TICKET_TYPE_SELECT_ID)
    .setPlaceholder(config?.ticket_panel_placeholder || DEFAULT_PLACEHOLDER);

  for (const type of types.slice(0, 25)) {
    const option = { label: type.name.slice(0, 100), value: String(type.id) };
    if (type.description) option.description = type.description.slice(0, 100);
    const emoji = parseEmojiInput(type.emoji);
    if (emoji) option.emoji = emoji;
    select.addOptions(option);
  }

  container.addActionRowComponents(new ActionRowBuilder().addComponents(select));

  return container;
}

// --- Buduje wiadomość powitalną wewnątrz nowo utworzonego kanału ticketu ---
function buildTicketWelcomeContainer(type, member, supportRoleId, isClosingConfirm = false) {
  const container = new ContainerBuilder().setAccentColor(parseColorToInt(type?.color));

  const emoji = type?.emoji ? `${type.emoji} ` : '🎫 ';
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${emoji}Ticket: ${type?.name ?? 'Ogólny'}`),
  );

  let intro = `Cześć <@${member.id}>! Dzięki za kontakt.`;
  if (type?.description) intro += `\n${type.description}`;
  intro += supportRoleId
    ? `\nZespół wsparcia (<@&${supportRoleId}>) odezwie się tak szybko, jak to możliwe.`
    : '\nZespół wsparcia odezwie się tak szybko, jak to możliwe.';

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(intro));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  if (isClosingConfirm) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('⚠️ **Na pewno chcesz zamknąć ten ticket?** Kanał zostanie usunięty.'),
    );
    const confirmButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_CONFIRM_ID)
      .setLabel('Tak, zamknij')
      .setStyle(ButtonStyle.Danger);
    const cancelButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_CANCEL_ID)
      .setLabel('Anuluj')
      .setStyle(ButtonStyle.Secondary);
    container.addActionRowComponents(new ActionRowBuilder().addComponents(confirmButton, cancelButton));
  } else {
    const closeButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_BUTTON_ID)
      .setLabel('Zamknij ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger);
    container.addActionRowComponents(new ActionRowBuilder().addComponents(closeButton));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# Tylko Ty i zespół wsparcia widzicie ten kanał.'),
    );
  }

  return container;
}

// Kliknięcie opcji w select menu na panelu - tworzy nowy, prywatny kanał ticketu.
async function handleTicketTypeSelect(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);

  if (!config?.ticket_category_id) {
    await interaction.reply({
      content: '⚠️ Administracja nie skonfigurowała jeszcze kategorii ticketów (`/setup-ticket kategoria ustaw`).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const category = await interaction.guild.channels.fetch(config.ticket_category_id).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.reply({
      content: '⚠️ Skonfigurowana kategoria ticketów już nie istnieje — zgłoś to administracji.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const limit = config.ticket_limit_per_user ?? 1;
  const openCount = await db.getOpenTicketsCountForUser(guildId, interaction.user.id);
  if (openCount >= limit) {
    await interaction.reply({
      content: `⚠️ Masz już otwarte ${openCount} ${openCount === 1 ? 'zgłoszenie' : 'zgłoszenia'} (limit: ${limit}). Zamknij poprzednie, zanim otworzysz nowe.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const typeId = interaction.values[0];
  const type = await db.getTicketType(typeId);
  if (!type) {
    await interaction.reply({ content: '⚠️ Ta kategoria ticketu już nie istnieje.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const permissionOverwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];

  if (config.ticket_support_role_id) {
    permissionOverwrites.push({
      id: config.ticket_support_role_id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: `ticket-${slugify(type.name)}-${slugify(interaction.user.username)}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites,
      topic: `Ticket (${type.name}) — otworzył/a ${interaction.user.tag} (${interaction.user.id})`,
    });
  } catch (err) {
    console.error('Błąd podczas tworzenia kanału ticketu:', err);
    await interaction.editReply({
      content:
        '❌ Nie udało się utworzyć kanału. Sprawdź, czy bot ma uprawnienie **Zarządzaj kanałami** ' +
        'w skonfigurowanej kategorii ticketów.',
    });
    return;
  }

  await db.createTicket(guildId, { channelId: channel.id, userId: interaction.user.id, typeId: type.id });

  const welcomeContainer = buildTicketWelcomeContainer(type, interaction.member, config.ticket_support_role_id, false);
  const pingContent = config.ticket_support_role_id
    ? `<@${interaction.user.id}> <@&${config.ticket_support_role_id}>`
    : `<@${interaction.user.id}>`;

  await channel.send({
    content: pingContent,
    components: [welcomeContainer],
    flags: V2_FLAGS,
    allowedMentions: { users: [interaction.user.id], roles: config.ticket_support_role_id ? [config.ticket_support_role_id] : [] },
  });

  await interaction.editReply({ content: `✅ Twój ticket został utworzony: ${channel}` });
}

// Kliknięcie "Zamknij ticket" - pokazuje ekran potwierdzenia w tej samej wiadomości.
async function handleTicketCloseClick(interaction) {
  const ticket = await db.getTicketByChannel(interaction.channel.id);
  if (!ticket) {
    await interaction.reply({ content: '⚠️ Nie znaleziono danych tego ticketu w bazie.', flags: MessageFlags.Ephemeral });
    return;
  }

  const type = ticket.type_id ? await db.getTicketType(ticket.type_id) : null;
  const config = await db.getGuildConfig(interaction.guild.id);

  const confirmContainer = buildTicketWelcomeContainer(type, { id: ticket.user_id }, config?.ticket_support_role_id, true);
  await interaction.update({ components: [confirmContainer], flags: V2_FLAGS });
}

// Kliknięcie "Anuluj" na ekranie potwierdzenia - wraca do normalnego widoku ticketu.
async function handleTicketCloseCancel(interaction) {
  const ticket = await db.getTicketByChannel(interaction.channel.id);
  const type = ticket?.type_id ? await db.getTicketType(ticket.type_id) : null;
  const config = await db.getGuildConfig(interaction.guild.id);

  const container = buildTicketWelcomeContainer(type, { id: ticket?.user_id ?? interaction.user.id }, config?.ticket_support_role_id, false);
  await interaction.update({ components: [container], flags: V2_FLAGS });
}

// Kliknięcie "Tak, zamknij" - zapisuje zamknięcie w bazie i usuwa kanał po krótkim odliczeniu.
async function handleTicketCloseConfirm(interaction) {
  await db.closeTicket(interaction.channel.id, { closedBy: interaction.user.id });

  // Wiadomość z Components V2 nie może mieć zwykłego "content" obok komponentów,
  // więc ekran zamykania też budujemy jako prosty kontener.
  const closingContainer = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🔒 Ticket zamknięty przez <@${interaction.user.id}>. Kanał zniknie za kilka sekund...`,
      ),
    );

  await interaction.update({ components: [closingContainer], flags: V2_FLAGS }).catch(() => null);

  setTimeout(() => {
    interaction.channel.delete('Ticket zamknięty').catch(err => console.error('Błąd podczas usuwania kanału ticketu:', err));
  }, 5000);
}

module.exports = {
  TICKET_TYPE_SELECT_ID,
  TICKET_CLOSE_BUTTON_ID,
  TICKET_CLOSE_CONFIRM_ID,
  TICKET_CLOSE_CANCEL_ID,
  V2_FLAGS,
  DEFAULT_PANEL_TITLE,
  DEFAULT_PANEL_TEXT,
  DEFAULT_PLACEHOLDER,
  parseEmojiInput,
  parseColorToInt,
  buildPanelContainer,
  buildTicketWelcomeContainer,
  handleTicketTypeSelect,
  handleTicketCloseClick,
  handleTicketCloseCancel,
  handleTicketCloseConfirm,
};
