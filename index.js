const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const CONFIG = {
  instituicaoNome: 'BOMBEIROS BMI',
  tituloPainel: '🚒 | BATE PONTO BOMBEIROS',
  tituloRanking: '🚒 | TOTAL DE HORAS REALIZADAS - BOMBEIROS',
  textoAssinatura: 'Atenciosamente, BOMBEIROS BMI',
  minimoMinutosParaContar: 30,
  autoFecharSegundos: 120,

  categoriasPermitidas: ['PATRULHAMENTO', 'BOMBEIROS'],
  canaisVozPermitidos: [],

  canalPainelId: process.env.CANAL_PAINEL_ID,
  canalRegistrosId: process.env.CANAL_REGISTROS_ID,
  canalRankingId: process.env.CANAL_RANKING_ID,

  cargoAdminIds: [process.env.CARGO_ADMIN_ID],
};

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ Faltam variáveis obrigatórias: TOKEN, CLIENT_ID ou GUILD_ID.');
  process.exit(1);
}

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const sessionsFile = path.join(dataDir, 'sessions.json');
const hoursFile = path.join(dataDir, 'hours.json');

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

let activeSessions = readJson(sessionsFile, {});
let userHours = readJson(hoursFile, {});
const pendingAutoClose = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

function saveSessions() {
  writeJson(sessionsFile, activeSessions);
}

function saveHours() {
  writeJson(hoursFile, userHours);
}

function msToHumanDetailed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return CONFIG.cargoAdminIds.some((id) => id && member.roles.cache.has(id));
}

function isVoiceAllowed(voiceChannel) {
  if (!voiceChannel) return false;

  if (CONFIG.canaisVozPermitidos.includes(voiceChannel.id)) return true;

  const parentName = voiceChannel.parent?.name?.toUpperCase() || '';
  const channelName = voiceChannel.name?.toUpperCase() || '';

  return (
    CONFIG.categoriasPermitidas.some((name) => parentName.includes(name.toUpperCase())) ||
    CONFIG.categoriasPermitidas.some((name) => channelName.includes(name.toUpperCase()))
  );
}

function buildPainelEmbed() {
  return new EmbedBuilder()
    .setTitle(CONFIG.tituloPainel)
    .setDescription(
      [
        'O bate-ponto é utilizado para contabilizar as horas de atividade de um membro no servidor.',
        `Cada ponto deverá possuir um acúmulo mínimo de **${CONFIG.minimoMinutosParaContar} minutos**, caso contrário não será contabilizado no banco de horas.`,
        '',
        '**Funcionamento**',
        '',
        'Para iniciar um registro de ponto, o membro deverá entrar em um canal de voz permitido e clicar no botão **ABRIR**.',
        '',
        `Para finalizar o registro, o membro deve permanecer no canal de voz e utilizar o botão **FECHAR**. Caso o membro saia do canal de voz sem utilizar o botão, o ponto será finalizado automaticamente após **${Math.floor(CONFIG.autoFecharSegundos / 60)} minutos**.`,
        '',
        'Para verificar o total de horas registradas, basta clicar no botão **HORAS**.',
        '',
        CONFIG.textoAssinatura,
      ].join('\n')
    )
    .setColor(0xff6a00);
}

function buildPainelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('abrir_ponto').setLabel('ABRIR').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('fechar_ponto').setLabel('FECHAR').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ver_horas').setLabel('HORAS').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ver_ranking').setLabel('RANKING').setStyle(ButtonStyle.Primary)
  );
}

function getUserTotalMs(userId) {
  return userHours[userId]?.totalMs || 0;
}

async function sendRegistro(guild, userId, startedAt, endedAt, totalMs, auto = false, counted = true) {
  const canal = guild.channels.cache.get(CONFIG.canalRegistrosId);
  if (!canal) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  const nome = member ? `<@${userId}>` : userId;

  const embed = new EmbedBuilder()
    .setTitle(`🚒 REGISTRO DE PONTO - ${CONFIG.instituicaoNome}`)
    .setDescription(
      [
        `👤 **MEMBRO:** ${nome}`,
        `➕ **INÍCIO:** <t:${Math.floor(startedAt / 1000)}:t>`,
        `📥 **TÉRMINO:** <t:${Math.floor(endedAt / 1000)}:t>`,
        `🕒 **TOTAL:** ${msToHumanDetailed(totalMs)}`,
        auto
          ? '🚨 **AVISO:** Ponto finalizado automaticamente pois o membro não retornou ao canal de voz.'
          : '✅ **AVISO:** Ponto finalizado manualmente.',
        counted
          ? '💾 **STATUS:** Registro contabilizado no banco de horas.'
          : `⚠️ **STATUS:** Registro não contabilizado por não atingir o mínimo de ${CONFIG.minimoMinutosParaContar} minutos.`,
      ].join('\n')
    )
    .setColor(counted ? 0x2ecc71 : 0xe67e22)
    .setTimestamp();

  await canal.send({ embeds: [embed] }).catch(() => null);
}

async function sendOrUpdateRanking(guild) {
  const canal = guild.channels.cache.get(CONFIG.canalRankingId);
  if (!canal) return;

  const ordered = Object.entries(userHours)
    .sort((a, b) => (b[1].totalMs || 0) - (a[1].totalMs || 0))
    .slice(0, 30);

  const lines = [];
  for (const [userId, info] of ordered) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const totalMs = info.totalMs || 0;
    const totalHours = totalMs / 1000 / 60 / 60;
    const emoji = totalHours >= 5 ? '🟢' : '🔴';
    const nome = member ? member.toString() : `<@${userId}>`;
    lines.push(`${emoji} ${nome}: **${msToHumanDetailed(totalMs)}**`);
  }

  if (lines.length === 0) lines.push('Nenhum registro encontrado até o momento.');

  const embed = new EmbedBuilder()
    .setTitle(CONFIG.tituloRanking)
    .setDescription(
      [
        'Todos os membros que realizaram qualquer registro no bate-ponto serão mencionados nesta lista.',
        '',
        '🟢 Membros que realizaram o mínimo de 05 horas.',
        '🔴 Membros que não atingiram as horas necessárias.',
        '',
        ...lines,
      ].join('\n')
    )
    .setColor(0xff6a00)
    .setTimestamp();

  const fetched = await canal.messages.fetch({ limit: 20 }).catch(() => null);
  const oldMessage = fetched?.find((m) => m.author.id === client.user.id && m.embeds.length > 0);

  if (oldMessage) {
    await oldMessage.edit({ embeds: [embed] }).catch(() => null);
  } else {
    await canal.send({ embeds: [embed] }).catch(() => null);
  }
}

async function openShift(interaction) {
  const member = interaction.member;
  const guild = interaction.guild;
  const voiceChannel = member.voice?.channel;

  if (!voiceChannel || !isVoiceAllowed(voiceChannel)) {
    return interaction.reply({
      content: 'Você precisa estar em um canal de voz permitido para abrir seu ponto.',
      ephemeral: true,
    });
  }

  if (activeSessions[member.id]) {
    return interaction.reply({
      content: 'Você já possui um ponto aberto.',
      ephemeral: true,
    });
  }

  activeSessions[member.id] = {
    startedAt: Date.now(),
    channelId: voiceChannel.id,
    guildId: guild.id,
  };
  saveSessions();

  return interaction.reply({
    content: `Seu ponto foi aberto com sucesso em **${voiceChannel.name}**.`,
    ephemeral: true,
  });
}

async function closeShift(interaction, auto = false, forceUserId = null) {
  const member = forceUserId
    ? await interaction.guild.members.fetch(forceUserId).catch(() => null)
    : interaction.member;

  const userId = forceUserId || interaction.user.id;
  const session = activeSessions[userId];

  if (!session) {
    if (!auto) {
      return interaction.reply({
        content: 'Você não possui nenhum ponto aberto.',
        ephemeral: true,
      });
    }
    return;
  }

  if (!auto) {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel || !isVoiceAllowed(voiceChannel)) {
      return interaction.reply({
        content: 'Para fechar seu ponto, você precisa estar em um canal de voz permitido.',
        ephemeral: true,
      });
    }
  }

  const endedAt = Date.now();
  const totalMs = endedAt - session.startedAt;
  const counted = totalMs >= CONFIG.minimoMinutosParaContar * 60 * 1000;

  delete activeSessions[userId];
  saveSessions();

  if (pendingAutoClose.has(userId)) {
    clearTimeout(pendingAutoClose.get(userId));
    pendingAutoClose.delete(userId);
  }

  if (!userHours[userId]) {
    userHours[userId] = { totalMs: 0, registros: 0 };
  }

  if (counted) {
    userHours[userId].totalMs += totalMs;
    userHours[userId].registros += 1;
    saveHours();
  }

  await sendRegistro(interaction.guild, userId, session.startedAt, endedAt, totalMs, auto, counted);
  await sendOrUpdateRanking(interaction.guild);

  if (!auto) {
    return interaction.reply({
      content: counted
        ? `Seu ponto foi fechado com sucesso. Tempo registrado: **${msToHumanDetailed(totalMs)}**.`
        : `Seu ponto foi fechado, porém não foi contabilizado por ter menos de **${CONFIG.minimoMinutosParaContar} minutos**. Tempo: **${msToHumanDetailed(totalMs)}**.`,
      ephemeral: true,
    });
  }
}

async function showHours(interaction) {
  const totalMs = getUserTotalMs(interaction.user.id);
  const session = activeSessions[interaction.user.id];
  const emAndamento = session ? Date.now() - session.startedAt : 0;

  const embed = new EmbedBuilder()
    .setTitle(`🚒 HORAS DE ${interaction.user.username.toUpperCase()}`)
    .setDescription(
      [
        `**Total contabilizado:** ${msToHumanDetailed(totalMs)}`,
        `**Ponto em andamento:** ${session ? msToHumanDetailed(emAndamento) : 'Nenhum'}`,
      ].join('\n')
    )
    .setColor(0xff6a00)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showRankingEphemeral(interaction) {
  const ordered = Object.entries(userHours)
    .sort((a, b) => (b[1].totalMs || 0) - (a[1].totalMs || 0))
    .slice(0, 10);

  const lines = [];
  let position = 1;

  for (const [userId, info] of ordered) {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    lines.push(`**${position}.** ${member ? member.toString() : `<@${userId}>`} - ${msToHumanDetailed(info.totalMs || 0)}`);
    position++;
  }

  const embed = new EmbedBuilder()
    .setTitle(`🏆 RANKING - ${CONFIG.instituicaoNome}`)
    .setDescription(lines.length ? lines.join('\n') : 'Nenhum registro encontrado até o momento.')
    .setColor(0xff6a00)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('painel')
      .setDescription('Envia o painel de bate-ponto.'),
    new SlashCommandBuilder()
      .setName('rankingpost')
      .setDescription('Atualiza ou envia a mensagem de ranking.'),
    new SlashCommandBuilder()
      .setName('zerarhoras')
      .setDescription('Zera as horas de um membro.')
      .addUserOption((option) =>
        option.setName('membro').setDescription('Membro que terá as horas zeradas.').setRequired(true)
      ),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registrados.');

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    await sendOrUpdateRanking(guild).catch(() => null);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({
        content: 'Você não tem permissão para usar este comando.',
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'painel') {
      const painelCanal = interaction.guild.channels.cache.get(CONFIG.canalPainelId);

      if (!painelCanal) {
        return interaction.reply({
          content: 'Canal do painel não encontrado.',
          ephemeral: true,
        });
      }

      await painelCanal.send({
        embeds: [buildPainelEmbed()],
        components: [buildPainelButtons()],
      });

      return interaction.reply({
        content: 'Painel enviado com sucesso.',
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'rankingpost') {
      await sendOrUpdateRanking(interaction.guild);
      return interaction.reply({
        content: 'Ranking atualizado com sucesso.',
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'zerarhoras') {
      const user = interaction.options.getUser('membro');
      userHours[user.id] = { totalMs: 0, registros: 0 };
      saveHours();
      await sendOrUpdateRanking(interaction.guild);

      return interaction.reply({
        content: `As horas de ${user} foram zeradas.`,
        ephemeral: true,
      });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'abrir_ponto') return openShift(interaction);
    if (interaction.customId === 'fechar_ponto') return closeShift(interaction, false);
    if (interaction.customId === 'ver_horas') return showHours(interaction);
    if (interaction.customId === 'ver_ranking') return showRankingEphemeral(interaction);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId = newState.id;
  const session = activeSessions[userId];
  if (!session) return;

  const leftAllowedVoice = !newState.channel || !isVoiceAllowed(newState.channel);
  const returnedToAllowedVoice = newState.channel && isVoiceAllowed(newState.channel);

  if (leftAllowedVoice && !pendingAutoClose.has(userId)) {
    const fakeInteraction = { guild: newState.guild };

    const timeout = setTimeout(async () => {
      await closeShift(fakeInteraction, true, userId);
    }, CONFIG.autoFecharSegundos * 1000);

    pendingAutoClose.set(userId, timeout);
  }

  if (returnedToAllowedVoice && pendingAutoClose.has(userId)) {
    clearTimeout(pendingAutoClose.get(userId));
    pendingAutoClose.delete(userId);
  }
});

client.login(TOKEN);
