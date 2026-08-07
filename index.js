process.loadEnvFile();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers, // potrzebne do nadawania ról po reakcji/przycisku
    GatewayIntentBits.MessageContent, // potrzebne, żeby Bob mógł czytać treść pytań po oznaczeniu go (@Bob)
  ],
  // Partials - żeby reakcje działały nawet na wiadomościach spoza pamięci podręcznej bota (np. po restarcie)
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

client.commands = new Collection();

// --- Ładowanie komend ---
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

// --- Ładowanie eventów ---
const eventsPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

// --- Obsługa komend slash, przycisków propozycji/ról, formularzy i menu wyboru ---
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    // Przycisk "Dodaj propozycję" - customId zawiera ID tablicy (board), np. "open_suggestion_modal:3"
    if (interaction.isButton() && interaction.customId.startsWith(BUTTON_CUSTOM_ID_PREFIX)) {
      const boardId = interaction.customId.slice(BUTTON_CUSTOM_ID_PREFIX.length);
      await interaction.showModal(buildModal(boardId));
      return;
    }

    // Wysłany formularz nowej propozycji (tytuł/opis/zdjęcie)
    if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_CUSTOM_ID_PREFIX)) {
      await handleModalSubmit(interaction);
      return;
    }

    // Wysłany formularz "własny styl" z /setup-propozycje styl:Własny
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
    const payload = { content: '❌ Wystąpił błąd podczas wykonywania tej akcji.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

// --- Start bota + porządkowanie po restarcie ---
client.once('ready', async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);
  await reconcileTempChannels();

  // XP za aktywność głosową - co COOLDOWN_MS (domyślnie 10 minut) dostają je wszyscy,
  // którzy w tym momencie siedzą na jakimś kanale głosowym (poza kanałem AFK).
  setInterval(() => {
    tickVoiceXp(client).catch(err => console.error('Błąd podczas przyznawania XP głosowego:', err));
  }, COOLDOWN_MS);
});

// Jeśli bot się zrestartuje, gdy jakieś tymczasowe kanały już istniały:
// - jeśli kanał zniknął albo jest pusty -> usuwamy wpis / kanał
// - jeśli ma ludzi -> zostawiamy go dalej, po prostu nie liczymy retroaktywnie czasu sprzed restartu
async function reconcileTempChannels() {
  const tempChannels = db.getAllTempChannels();
  for (const temp of tempChannels) {
    try {
      const guild = await client.guilds.fetch(temp.guild_id).catch(() => null);
      if (!guild) {
        db.removeTempChannel(temp.channel_id);
        continue;
      }
      const channel = await guild.channels.fetch(temp.channel_id).catch(() => null);
      if (!channel) {
        db.removeTempChannel(temp.channel_id);
        continue;
      }
      if (channel.members.size === 0) {
        await channel.delete('Sprzątanie po restarcie bota - kanał był pusty').catch(() => null);
        db.removeTempChannel(temp.channel_id);
      }
    } catch (err) {
      console.error('Błąd podczas porządkowania kanałów tymczasowych:', err);
    }
  }
}

client.login(process.env.DISCORD_TOKEN);
