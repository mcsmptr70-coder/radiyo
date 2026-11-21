'use strict';

/**
 * Virgin Radio Türkiye - Discord Radyo Botu
 * Bu bot yalnızca Virgin Radio çalar.
 *
 * Komutlar:
 *   /radyo  -> Bulunduğun ses kanalına girer ve Virgin Radio'yu başlatır
 *   /dur    -> Radyoyu durdurur ve kanaldan çıkar
 *   /ses    -> Ses seviyesini ayarlar (1-100)
 */

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');

const { FFmpeg } = require('prism-media');

// ---------------------------------------------------------------------------
// Ayarlar
// ---------------------------------------------------------------------------

const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
if (!TOKEN || TOKEN.startsWith('buraya_')) {
  console.error('HATA: .env dosyasında DISCORD_TOKEN bulunamadı. Lütfen bot tokenini yaz.');
  process.exit(1);
}

// Virgin Radio Türkiye yayın adresleri (sırayla denenir, biri çalışmazsa diğerine geçilir)
const DEFAULT_STREAMS = [
  'https://playerservices.streamtheworld.com/api/livestream-redirect/VIRGIN_RADIO.mp3',
  'https://playerservices.streamtheworld.com/api/livestream-redirect/VIRGIN_RADIOAAC.aac',
  'https://playerservices.streamtheworld.com/api/livestream-redirect/VIRGIN_RADIO_SC',
];
const customStream = (process.env.STREAM_URL || '').trim();
const STREAM_URLS = customStream ? [customStream, ...DEFAULT_STREAMS] : DEFAULT_STREAMS;

const parsedVolume = Number.parseInt(process.env.DEFAULT_VOLUME || '70', 10);
const DEFAULT_VOLUME = Number.isFinite(parsedVolume) ? Math.min(100, Math.max(1, parsedVolume)) : 70;

const AUTO_JOIN_CHANNEL_ID = (process.env.AUTO_JOIN_CHANNEL_ID || '').trim();

// ---------------------------------------------------------------------------
// Slash komutları
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('radyo')
    .setDescription("Bulunduğun ses kanalında Virgin Radio'yu başlatır")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('dur')
    .setDescription('Radyoyu durdurur ve ses kanalından çıkar')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('ses')
    .setDescription('Ses seviyesini ayarlar')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt
        .setName('seviye')
        .setDescription('1 ile 100 arasında bir değer')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    ),
].map((c) => c.toJSON());

// ---------------------------------------------------------------------------
// Durum yönetimi
// ---------------------------------------------------------------------------

/** guildId -> { guildId, connection, player, resource, volume, stopped, retryTimer, urlIndex, failCount, startedAt } */
const states = new Map();
/** Aynı anda iki kez bağlanmayı engellemek için */
const joining = new Set();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString('tr-TR')}]`, ...args);
}

function safeDestroy(connection) {
  try {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  } catch (err) {
    // zaten yok edilmiş olabilir
  }
}

// ---------------------------------------------------------------------------
// Yayın oynatma
// ---------------------------------------------------------------------------

function createRadioResource(url, volume) {
  const transcoder = new FFmpeg({
    args: [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_delay_max', '5',
      '-rw_timeout', '15000000', // 15 sn veri gelmezse bağlantıyı yenile
      '-user_agent', 'Mozilla/5.0 (compatible; VirginRadioDiscordBot/1.0)',
      '-i', url,
      '-vn',
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
    ],
  });

  transcoder.on('error', (err) => {
    console.error('FFmpeg hatası:', err && err.message ? err.message : err);
  });

  const resource = createAudioResource(transcoder, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });
  if (resource.volume) resource.volume.setVolume(volume / 100);
  return resource;
}

function startPlayback(state) {
  if (state.stopped) return;
  const url = STREAM_URLS[state.urlIndex % STREAM_URLS.length];
  try {
    const resource = createRadioResource(url, state.volume);
    state.resource = resource;
    state.startedAt = Date.now();
    state.player.play(resource);
    log(`[${state.guildId}] Virgin Radio başlatıldı (${url})`);
  } catch (err) {
    console.error('Yayın başlatılamadı:', err);
    state.startedAt = Date.now();
    scheduleRestart(state);
  }
}

function scheduleRestart(state) {
  if (state.stopped || state.retryTimer) return;

  // 15 saniyeden kısa sürede kapandıysa yayın hatalı demektir: sıradaki adrese geç
  const quickFail = Date.now() - state.startedAt < 15_000;
  if (quickFail) {
    state.failCount += 1;
    state.urlIndex += 1;
  } else {
    state.failCount = 0;
  }

  const delay = Math.min(3_000 * 2 ** Math.min(state.failCount, 4), 30_000);
  log(`[${state.guildId}] Yayın kesildi, ${Math.round(delay / 1000)} sn sonra yeniden denenecek.`);

  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    startPlayback(state);
  }, delay);
}

function teardown(state) {
  state.stopped = true;
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  try {
    state.player.stop(true);
  } catch (err) {
    // önemli değil
  }
  if (states.get(state.guildId) === state) states.delete(state.guildId);
}

function stopRadio(guildId) {
  const state = states.get(guildId);
  if (!state) return false;
  teardown(state);
  safeDestroy(state.connection);
  return true;
}

async function startRadio(guild, voiceChannel) {
  if (joining.has(guild.id)) {
    throw new Error('Şu anda ses kanalına bağlanılıyor, lütfen birkaç saniye bekle.');
  }

  const existing = states.get(guild.id);
  if (
    existing &&
    existing.connection.state.status !== VoiceConnectionStatus.Destroyed &&
    existing.connection.joinConfig.channelId === voiceChannel.id
  ) {
    // Zaten bu kanalda; çalmıyorsa yeniden başlat
    if (existing.player.state.status === AudioPlayerStatus.Idle) {
      if (existing.retryTimer) {
        clearTimeout(existing.retryTimer);
        existing.retryTimer = null;
      }
      startPlayback(existing);
    }
    return 'already';
  }

  joining.add(guild.id);
  try {
    if (existing) stopRadio(guild.id);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    connection.on('error', (err) => console.error('Ses bağlantısı hatası:', err));

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      safeDestroy(connection);
      throw new Error('Ses kanalına bağlanılamadı. Botun kanala girme iznini kontrol edip tekrar dene.');
    }

    // Sahne (stage) kanalıysa konuşmacı olmayı dene
    if (voiceChannel.type === ChannelType.GuildStageVoice) {
      try {
        await guild.members.me.voice.setSuppressed(false);
      } catch (err) {
        // izin yoksa sessiz kalır
      }
    }

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    const state = {
      guildId: guild.id,
      connection,
      player,
      resource: null,
      volume: existing ? existing.volume : DEFAULT_VOLUME,
      stopped: false,
      retryTimer: null,
      urlIndex: 0,
      failCount: 0,
      startedAt: Date.now(),
    };
    states.set(guild.id, state);

    player.on(AudioPlayerStatus.Idle, () => scheduleRestart(state));
    player.on('error', (err) => {
      console.error('Oynatıcı hatası:', err && err.message ? err.message : err);
      scheduleRestart(state);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Kanal değiştirilmiş olabilir; yeniden bağlanmasını bekle
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (err) {
        safeDestroy(connection);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      // /dur ile kapatılmadıysa (atıldı, kanal silindi vb.) durumu temizle
      if (states.get(guild.id) !== state) return;
      const lastChannelId = connection.joinConfig.channelId;
      teardown(state);
      if (AUTO_JOIN_CHANNEL_ID && lastChannelId === AUTO_JOIN_CHANNEL_ID) {
        setTimeout(() => autoJoin(), 10_000);
      }
    });

    connection.subscribe(player);
    startPlayback(state);
    return 'started';
  } finally {
    joining.delete(guild.id);
  }
}

// ---------------------------------------------------------------------------
// Otomatik katılma (7/24 mod)
// ---------------------------------------------------------------------------

async function autoJoin() {
  if (!AUTO_JOIN_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(AUTO_JOIN_CHANNEL_ID);
    if (!channel || !channel.guild || !channel.isVoiceBased()) {
      console.error('AUTO_JOIN_CHANNEL_ID geçerli bir ses kanalı değil.');
      return;
    }
    if (states.has(channel.guild.id)) return;
    if (!channel.joinable) {
      throw new Error('Botun bu kanala girme izni yok.');
    }
    await startRadio(channel.guild, channel);
    log(`Otomatik olarak "${channel.name}" kanalına girildi.`);
  } catch (err) {
    console.error('Otomatik katılma başarısız, 15 sn sonra tekrar denenecek:', err.message || err);
    setTimeout(() => autoJoin(), 15_000);
  }
}

// ---------------------------------------------------------------------------
// Discord olayları
// ---------------------------------------------------------------------------

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
  } catch (err) {
    console.error(`"${guild.name}" sunucusuna komutlar eklenemedi:`, err.message || err);
  }
}

client.once(Events.ClientReady, async (c) => {
  log(`${c.user.tag} olarak giriş yapıldı.`);
  c.user.setPresence({
    activities: [{ name: 'Virgin Radio', type: ActivityType.Listening }],
    status: 'online',
  });

  for (const guild of c.guilds.cache.values()) {
    await registerCommands(guild);
  }
  log('Komutlar hazır: /radyo, /dur, /ses');

  autoJoin();
});

client.on(Events.GuildCreate, (guild) => registerCommands(guild));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: 'Bu komut sadece sunucularda kullanılabilir.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const guild = interaction.guild;

    if (interaction.commandName === 'radyo') {
      const voiceChannel = interaction.member && interaction.member.voice && interaction.member.voice.channel;
      if (!voiceChannel) {
        await interaction.editReply('Önce bir ses kanalına girmen gerekiyor.');
        return;
      }
      if (!voiceChannel.joinable) {
        await interaction.editReply('Bu ses kanalına girme iznim yok veya kanal dolu.');
        return;
      }
      if (!voiceChannel.speakable) {
        await interaction.editReply('Bu ses kanalında konuşma iznim yok.');
        return;
      }

      const result = await startRadio(guild, voiceChannel);
      await interaction.editReply(
        result === 'already'
          ? `📻 Virgin Radio zaten **${voiceChannel.name}** kanalında çalıyor.`
          : `📻 **Virgin Radio** şimdi **${voiceChannel.name}** kanalında çalıyor!`,
      );
      return;
    }

    if (interaction.commandName === 'dur') {
      const stopped = stopRadio(guild.id);
      await interaction.editReply(stopped ? '⏹️ Radyo durduruldu ve kanaldan çıkıldı.' : 'Şu anda çalan bir radyo yok.');
      return;
    }

    if (interaction.commandName === 'ses') {
      const level = interaction.options.getInteger('seviye', true);
      const state = states.get(guild.id);
      if (!state) {
        await interaction.editReply('Şu anda çalan bir radyo yok. Önce /radyo yaz.');
        return;
      }
      state.volume = level;
      if (state.resource && state.resource.volume) {
        state.resource.volume.setVolume(level / 100);
      }
      await interaction.editReply(`🔊 Ses seviyesi **%${level}** olarak ayarlandı.`);
      return;
    }

    await interaction.editReply('Bilinmeyen komut.');
  } catch (err) {
    console.error('Komut hatası:', err);
    const message = `❌ ${err && err.message ? err.message : 'Beklenmeyen bir hata oluştu.'}`;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message);
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    } catch (replyErr) {
      // yanıt verilemiyorsa yapacak bir şey yok
    }
  }
});

client.on(Events.Error, (err) => console.error('Discord istemci hatası:', err));

// Beklenmeyen hatalar botu çökertmesin
process.on('unhandledRejection', (err) => console.error('Yakalanmayan söz hatası:', err));
process.on('uncaughtException', (err) => console.error('Yakalanmayan hata:', err));

// Düzgün kapanış
function shutdown() {
  log('Kapatılıyor...');
  for (const guildId of [...states.keys()]) stopRadio(guildId);
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(TOKEN).catch((err) => {
  console.error('Giriş yapılamadı. Token doğru mu?', err.message || err);
  process.exit(1);
});
