const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { levelForXp } = require('../utils/leveling');
const { syncLevelRole } = require('../utils/levelRoles');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nagroda') // <-- Zmiana komendy na /nagroda
    .setDescription('Odbierz swoją dzienną nagrodę XP (reset o północy)!'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // 1. Sprawdzenie możliwości odbioru dzisiaj
    const canClaim = await db.canClaimDaily(guildId, userId);
    if (!canClaim) {
      await interaction.reply({
        content: '⏰ Odebrałeś/aś już dzisiejszą nagrodę! Wróć po północy (00:00).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 2. Losowanie skrzyni i nagrody XP
    const roll = Math.random();
    let tier = '';
    let color = 0x000000;
    let minXp = 0;
    let maxXp = 0;

    if (roll < 0.35) {
      tier = '⚪ Pospolita Skrzynia';
      color = 0x95a5a6;
      minXp = 50;
      maxXp = 100;
    } else if (roll < 0.63) {
      tier = '🟢 Niezwykła Skrzynia';
      color = 0x2ecc71;
      minXp = 101;
      maxXp = 200;
    } else if (roll < 0.82) {
      tier = '🔵 Rzadka Skrzynia';
      color = 0x3498db;
      minXp = 201;
      maxXp = 350;
    } else if (roll < 0.92) {
      tier = '🟣 Legendarna Skrzynia';
      color = 0x9b59b6;
      minXp = 351;
      maxXp = 600;
    } else if (roll < 0.975) {
      tier = '🟠 Mityczna Skrzynia!';
      color = 0xe67e22;
      minXp = 601;
      maxXp = 1200;
    } else if (roll < 0.995) {
      tier = '🔴 Boska Skrzynia!!';
      color = 0xe74c3c;
      minXp = 1201;
      maxXp = 2200;
    } else {
      tier = '⚫ VOID SKRZYNIA!!!';
      color = 0x1a1a2e;
      minXp = 3000;
      maxXp = 6000;
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
