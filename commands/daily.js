const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');
const { levelForXp } = require('../utils/leveling');
const { syncLevelRole } = require('../utils/levelRoles');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Odbierz swoją dzienną nagrodę XP (reset o północy)!'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // 1. Sprawdzenie możliwości odbioru dzisiaj (kolejność: guildId, userId)
    const canClaim = await db.canClaimDaily(guildId, userId);
    if (!canClaim) {
      await interaction.reply({
        content: '⏰ Odebrałeś/aś już dzisiejszą nagrodę! Wróć po północy (00:00).',
        ephemeral: true,
      });
      return;
    }

    // 2. Losowanie skrzyni i nagrody XP
    const roll = Math.random();
    let tier = '';
    let color = 0x000000;
    let minXp = 0;
    let maxXp = 0;

    if (roll < 0.60) {
      tier = '⚪ Zwykła Skrzynia';
      color = 0x95a5a6;
      minXp = 50;
      maxXp = 150;
    } else if (roll < 0.90) {
      tier = '🔵 Dobra Skrzynia';
      color = 0x3498db;
      minXp = 151;
      maxXp = 300;
    } else if (roll < 0.99) {
      tier = '🟣 Mityczna Skrzynia';
      color = 0x9b59b6;
      minXp = 301;
      maxXp = 500;
    } else {
      tier = '🟡 LEGENDARNA SKRZYNIA!';
      color = 0xf1c40f;
      minXp = 2500;
      maxXp = 5000;
    }

    const rewardXp = Math.floor(Math.random() * (maxXp - minXp + 1)) + minXp;

    // 3. Zapis w bazie danych i dodanie XP
    await db.setDailyClaimed(guildId, userId);
    const { oldLevel, newLevel } = await db.addXp(guildId, userId, rewardXp, 'daily', levelForXp);

    if (newLevel > oldLevel) {
      await syncLevelRole(interaction.client, guildId, userId, newLevel);
    }

    // 4. Odpowiedź na Discordzie
    const embed = new EmbedBuilder()
      .setTitle('🎁 Dzienny Prezent Odbierania XP')
      .setColor(color)
      .setDescription(
        `Udało Ci się wyciągnąć: **${tier}**!\n\n` +
        `✨ Twoja nagroda: **+${rewardXp} XP**\n` +
        (newLevel > oldLevel ? `🎉 **AWANS! Osiągnięto poziom ${newLevel}!**` : `Poziom: **${newLevel}**`)
      )
      .setFooter({ text: 'Możesz odebrać kolejną skrzynkę jutro po 00:00!' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
