// Bezpieczne wczytywanie .env
try {
  process.loadEnvFile();
} catch (err) {
  // Ignoruj brak pliku .env w środowisku produkcyjnym
}

const express = require('express'); // <-- Wczytanie Express
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials, MessageFlags, REST, Routes } = require('discord.js');
const db = require('./db');
const {
  BUTTON_CUSTOM_ID_PREFIX,
  MODAL_CUSTOM_ID_PREFIX,
  STYLE_MODAL_CUSTOM_ID_PREFIX,
  buildModal,
  handleModalSubmit,
  handleStyleModalSubmit,
} = require('./utils/suggestions');
const { handleRoleButtonClick } = require('./utils/rolePanels');
const { tickVoiceXp, COOLDOWN_MS } = require('./utils/leveling');
const { LEVEL_ROLE_SELECT_CUSTOM_ID, handleLevelRoleSelectMenu } = require('./utils/levelRoles');

// --- Uruchomienie prostego serwera HTTP dla Render.com ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Bot działa poprawnie 24/7!');
});

app.listen(PORT, () => {
  console.log(`🌐 Serwer HTTP dla Render uruchomiony na porcie ${PORT}`);
});

// --- Konfiguracja Klienta Discord ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

client.commands = new Collection();

// --- Ładowanie komend ---
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
  for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
  }
}

// --- Ładowanie eventów z folderu /events ---
const eventsPath = path.join(__dirname, 'events');
if (fs.existsSync(eventsPath)) {
  for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
  }
}

// --- Obsługa interakcji ---
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(BUTTON_CUSTOM_ID_PREFIX)) {
      const boardId = interaction.customId.slice(BUTTON_CUSTOM_ID_PREFIX.length);
      await interaction.showModal(buildModal(boardId));
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_CUSTOM_ID_PREFIX)) {
      await handleModalSubmit(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(STYLE_MODAL_CUSTOM_ID_PREFIX)) {
      await handleStyleModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('role_btn_')) {
      await handleRoleButtonClick(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === LEVEL_ROLE_SELECT_CUSTOM_ID) {
      await handleLevelRoleSelectMenu(interaction);
      return;
    }
  } catch (err) {
    console.error('Błąd podczas obsługi interakcji:', err);
    const payload = { content: '❌ Wystąpił błąd podczas wykonywania tej akcji.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

// --- Start bota ---
client.once('ready', async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);

  // 1. Automatyczne odświeżenie i rejestracja komend Slash w API Discorda
  await registerSlashCommands();

  // 2. Porządkowanie kanałów tymczasowych
  await reconcileTempChannels();

  // 3. Jednorazowe wstawienie domyślnego rekordu sesji głosowej (jeśli tabela jest pusta)
  await seedInitialVoiceRecord();

  // 4. Pętla XP za głosowe
  const scheduleVoiceTick = () => {
    const randomMinutes = Math.floor(Math.random() * (10 - 5 + 1)) + 5; // 5 - 10 min
    setTimeout(async () => {
      await tickVoiceXp(client).catch(err => console.error('Błąd XP głosowego:', err));
      scheduleVoiceTick();
    }, randomMinutes * 60 * 1000);
  };
  scheduleVoiceTick();
});

// Funkcja rejestrująca komendy Slash w Discord API
async function registerSlashCommands() {
  try {
    const commandsData = Array.from(client.commands.values()).map(c => c.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    console.log('🔄 Rejestrowanie/Aktualizowanie komend Slash...');
    
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commandsData }
    );

    console.log('✅ Wszystkie komendy Slash (w tym /nagroda) zostały zarejestrowane!');
  } catch (error) {
    console.error('❌ Błąd podczas rejestracji komend Slash:', error);
  }
}

// Funkcja dodająca jednorazowy rekord startowy do tabeli sesji głosowych
async function seedInitialVoiceRecord() {
  try {
    const check = await db.raw.query('SELECT COUNT(*)::int as count FROM sessions');
    if (check.rows[0].count === 0) {
      const now = Date.now();
      await db.raw.query(`
        INSERT INTO sessions (guild_id, channel_id, creator_id, started_at, ended_at, duration_seconds)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['0', '0', 'SYSTEM', now - 1000, now, 1]);
      console.log('📌 Dodano początkowy rekord do tabeli sesji głosowych.');
    }
  } catch (err) {
    console.error('❌ Nie udało się dodać rekordu do tabeli sesji:', err);
  }
}

async function reconcileTempChannels() {
  const tempChannels = await db.getAllTempChannels();
  if (!tempChannels) return;

  for (const temp of tempChannels) {
    try {
      const guild = await client.guilds.fetch(temp.guild_id).catch(() => null);
      if (!guild) {
        await db.removeTempChannel(temp.channel_id);
        continue;
      }
      
      const channel = await guild.channels.fetch(temp.channel_id, { force: true }).catch(() => null);
      if (!channel) {
        await db.removeTempChannel(temp.channel_id);
        continue;
      }

      if (channel.members.size === 0) {
        await channel.delete('Sprzątanie po restarcie bota - kanał był pusty').catch(() => null);
        await db.removeTempChannel(temp.channel_id);
      }
    } catch (err) {
      console.error('Błąd podczas porządkowania kanałów tymczasowych:', err);
    }
  }
}

client.login(process.env.DISCORD_TOKEN);
