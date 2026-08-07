const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const db = require('../db');

const LEVEL_ROLE_SELECT_CUSTOM_ID = 'level_role_remove_select';

// Sprawdza jaka rola przysługuje na danym poziomie i synchronizuje ją użytkownikowi:
// - usuwa WSZYSTKIE inne role z tej drabinki (żeby nie stakować, tylko zawsze mieć jedną, aktualną)
// - nadaje właściwą rolę, jeśli jej jeszcze nie ma
async function syncLevelRole(client, guildId, userId, level) {
  const tiers = db.getLevelRoles(guildId); // posortowane malejąco po poziomie
  if (tiers.length === 0) return;

  const applicable = tiers.find(t => t.level <= level);
  if (!applicable) return; // brak roli obejmującej tak niski poziom (np. nie ustawiono roli na poziomie 0)

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const allTierRoleIds = new Set(tiers.map(t => t.role_id));
  const toRemove = member.roles.cache.filter(r => allTierRoleIds.has(r.id) && r.id !== applicable.role_id);

  try {
    if (toRemove.size > 0) {
      await member.roles.remove([...toRemove.keys()]);
    }
    if (!member.roles.cache.has(applicable.role_id)) {
      await member.roles.add(applicable.role_id);
    }
  } catch (err) {
    console.error('Błąd podczas synchronizacji roli za poziom (sprawdź hierarchię ról bota):', err);
  }
}

// Buduje embed + listę rozwijaną (select menu) do /rola-poziom lista.
// Wybranie pozycji z listy usuwa dany poziom z drabinki (obsługuje to handleLevelRoleSelectMenu).
function buildLevelRolesListPayload(guild) {
  const tiers = db.getLevelRoles(guild.id); // malejąco po poziomie
  if (tiers.length === 0) {
    return {
      content: '⚠️ Nie masz jeszcze skonfigurowanej drabinki ról - użyj najpierw `/rola-poziom ustaw`.',
      components: [],
    };
  }

  const sortedAsc = [...tiers].sort((a, b) => a.level - b.level);

  const embed = new EmbedBuilder()
    .setTitle('🏅 Drabinka ról za poziomy')
    .setColor(0x5865f2)
    .setDescription(sortedAsc.map(t => `**Poziom ${t.level}** — <@&${t.role_id}>`).join('\n'))
    .setFooter({ text: 'Wybierz pozycję z listy poniżej, żeby usunąć ją z drabinki.' });

  // Discord select menu pozwala max 25 opcji - jeśli masz więcej poziomów, tniemy do pierwszych 25
  const options = sortedAsc.slice(0, 25).map(t => {
    const role = guild.roles.cache.get(t.role_id);
    return new StringSelectMenuOptionBuilder()
      .setLabel(`Poziom ${t.level}${role ? ` — ${role.name}` : ''}`.slice(0, 100))
      .setValue(String(t.level));
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(LEVEL_ROLE_SELECT_CUSTOM_ID)
    .setPlaceholder('Wybierz rolę do usunięcia z drabinki...')
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(select);

  return { embeds: [embed], components: [row] };
}

// Obsługa wyboru z listy rozwijanej - usuwa wybrany poziom z drabinki
async function handleLevelRoleSelectMenu(interaction) {
  const level = parseInt(interaction.values[0], 10);
  const tiers = db.getLevelRoles(interaction.guild.id);
  const tier = tiers.find(t => t.level === level);

  db.removeLevelRole(interaction.guild.id, level);

  await interaction.update({
    content: tier
      ? `✅ Usunięto przypisanie roli <@&${tier.role_id}> dla poziomu **${level}** z drabinki.`
      : `✅ Usunięto przypisanie dla poziomu **${level}**.`,
    embeds: [],
    components: [],
  });
}

module.exports = {
  syncLevelRole,
  buildLevelRolesListPayload,
  LEVEL_ROLE_SELECT_CUSTOM_ID,
  handleLevelRoleSelectMenu,
};
