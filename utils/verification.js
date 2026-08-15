const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const db = require('../db');
const { parseEmojiInput } = require('./rolePanels');

const RULE_EXPAND_PREFIX = 'rule_expand_';

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
  DEFAULT_RULES_TEXT,
  formatEmojiForReact,
  buildIntroEmbed,
  buildRulePointEmbed,
  buildRulePointButtonRow,
  buildFinalVerifyEmbed,
  handleRuleExpandClick,
  handleVerifyReaction,
};
