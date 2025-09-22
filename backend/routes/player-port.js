const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// GET /api/player-port/iframe - Player iFrame na porta do sistema
router.get('/iframe', async (req, res) => {
    try {
        const { stream, playlist, video, player_type = 'html5', login, vod, aspectratio = '16:9', autoplay = 'false', muted = 'false', loop = 'false', contador = 'false', compartilhamento = 'false', player = '1' } = req.query;

        let videoUrl = '';
        let title = 'Player';
        let isLive = false;
        let userLogin = login || 'usuario';
        let vodPath = vod || '';
        let playlistId = playlist || '';

        console.log('🎥 Player iFrame request:', {
            login,
            stream,
            playlist,
            video,
            vod,
            userLogin
        });

        // Construir URL baseado nos parâmetros
        if (vodPath) {
            // VOD específico
            const wowzaHost = 'stmv1.udicast.com'; // SEMPRE usar domínio

            // Garantir que o arquivo é MP4
            const vodPathParts = vodPath.split('/');
            if (vodPathParts.length >= 2) {
                const folderName = vodPathParts[0];
                const fileName = vodPathParts[1];
                const finalFileName = fileName.endsWith('.mp4') ? fileName : fileName.replace(/\.[^/.]+$/, '.mp4');
                videoUrl = `http://${wowzaHost}:80/vod/_definst_/mp4:${userLogin}/${folderName}/${finalFileName}/playlist.m3u8`;
            } else {
                videoUrl = `http://${wowzaHost}:80/vod/_definst_/mp4:${userLogin}/default/${vodPath}/playlist.m3u8`;
            }

            title = `VOD: ${vodPath}`;
            isLive = false;
        } else if (playlistId) {
            // Playlist específica - verificar se há transmissão ativa no banco
            try {
                console.log(`🔍 Verificando transmissão ativa para playlist ${playlistId}...`);
                const [activeTransmission] = await db.execute(
                    'SELECT t.*, p.nome as playlist_nome FROM transmissoes t LEFT JOIN playlists p ON t.codigo_playlist = p.id WHERE t.codigo_playlist = ? AND t.status = "ativa" LIMIT 1',
                    [playlistId]
                );

                if (activeTransmission.length > 0) {
                    const transmission = activeTransmission[0];
                    console.log(`✅ Transmissão ativa encontrada:`, transmission);

                    // Buscar userLogin correto da transmissão
                    const [userRows] = await db.execute(
                        'SELECT s.usuario, s.email FROM streamings s WHERE s.codigo_cliente = ? LIMIT 1',
                        [transmission.codigo_stm]
                    );

                    if (userRows.length > 0) {
                        const userData = userRows[0];
                        userLogin = userData.usuario || (userData.email ? userData.email.split('@')[0] : userLogin);
                    }

                    const wowzaHost = 'stmv1.udicast.com';

                    // Para transmissão SMIL, usar URL específica do usuário
                    videoUrl = `http://${wowzaHost}:1935/${userLogin}/smil:playlists_agendamentos.smil/playlist.m3u8`;
                    title = `Playlist: ${transmission.playlist_nome}`;
                    isLive = true;

                    console.log(`🎬 URL da playlist ativa: ${videoUrl}`);
                } else {
                    console.log(`⚠️ Playlist ${playlistId} não está em transmissão ativa`);
                    // Verificar se há stream OBS ativo como fallback
                    try {
                        const [userRows] = await db.execute(
                            'SELECT s.usuario, s.email FROM streamings s WHERE s.codigo_cliente = ? LIMIT 1',
                            [userId]
                        );

                        if (userRows.length > 0) {
                            const userData = userRows[0];
                            const fallbackUserLogin = userData.usuario || (userData.email ? userData.email.split('@')[0] : userLogin);

                            // Buscar domínio do servidor Wowza
                            let wowzaHost = 'stmv1.udicast.com';
                            try {
                                const [serverRows] = await db.execute(
                                    'SELECT dominio, ip FROM wowza_servers WHERE status = "ativo" LIMIT 1'
                                );
                                if (serverRows.length > 0) {
                                    // SEMPRE usar domínio do Wowza, nunca IP
                                    wowzaHost = 'stmv1.udicast.com';
                                }
                            } catch (error) {
                                console.warn('Erro ao buscar domínio do servidor:', error.message);
                            }

                            videoUrl = `http://${wowzaHost}:1935/samhost/${userLogin}_live/playlist.m3u8`;
                            title = `Stream OBS - ${fallbackUserLogin}`;
                            isLive = true;
                        } else {
                            // Playlist não está em transmissão - mostrar "sem sinal"
                            videoUrl = '';
                            title = `Playlist Offline - ${playlistId}`;
                            isLive = false;
                        }
                    } catch (error) {
                        console.error('Erro ao verificar fallback OBS:', error);
                        videoUrl = '';
                        title = `Playlist Offline - ${playlistId}`;
                        isLive = false;
                    }
                }
            } catch (error) {
                console.error('Erro ao verificar playlist:', error);
                videoUrl = '';
                title = 'Erro na Playlist';
                isLive = false;
            }
        } else if (login && !stream && !video && !vod) {
            // Stream padrão do usuário baseado no login
            try {
                console.log(`🔍 Verificando transmissão ativa para usuário ${login}...`);

                // 1. Verificar transmissão de playlist primeiro
                const [userTransmission] = await db.execute(
                    'SELECT t.*, p.nome as playlist_nome FROM transmissoes t LEFT JOIN playlists p ON t.codigo_playlist = p.id LEFT JOIN streamings s ON t.codigo_stm = s.codigo_cliente WHERE (s.usuario = ? OR s.email LIKE ?) AND t.status = "ativa" LIMIT 1',
                    [login, `${login}@%`]
                );

                if (userTransmission.length > 0) {
                    const transmission = userTransmission[0];
                    console.log(`✅ Transmissão de usuário encontrada:`, transmission);
                    const wowzaHost = 'stmv1.udicast.com';
                    videoUrl = `http://${wowzaHost}:1935/samhost/smil:playlists_agendamentos.smil/playlist.m3u8`;
                    title = `Playlist: ${transmission.playlist_nome}`;
                    isLive = true;
                } else {
                    console.log(`⚠️ Nenhuma transmissão de playlist para usuário ${login}, verificando OBS...`);

                    // 2. Verificar transmissão OBS via API Wowza
                    try {
                        // Buscar userId baseado no login
                        const [userIdRows] = await db.execute(
                            'SELECT codigo_cliente FROM streamings WHERE usuario = ? OR email LIKE ? LIMIT 1',
                            [login, `${login}@%`]
                        );
                        
                        if (userIdRows.length > 0) {
                            const userIdForWowza = userIdRows[0].codigo_cliente;
                            const WowzaStreamingService = require('../config/WowzaStreamingService');
                            const incomingStreamsResult = await WowzaStreamingService.checkUserIncomingStreams(userIdForWowza);
                            
                            if (incomingStreamsResult.hasActiveStreams) {
                                console.log(`✅ Stream OBS ativo encontrado para ${login}:`, incomingStreamsResult.activeStreams[0].name);
                                const wowzaHost = 'stmv1.udicast.com';
                                videoUrl = `http://${wowzaHost}:1935/samhost/${login}_live/playlist.m3u8`;
                                title = `Stream OBS - ${login}`;
                                isLive = true;
                            } else {
                                console.log(`⚠️ Nenhum incoming stream ativo para usuário ${login}`);
                                // Sem transmissão ativa - mostrar "sem sinal"
                                videoUrl = '';
                                title = `Sem Transmissão - ${login}`;
                                isLive = false;
                            }
                        } else {
                            console.log(`⚠️ Usuário ${login} não encontrado no banco`);
                            videoUrl = '';
                            title = `Usuário não encontrado - ${login}`;
                            isLive = false;
                        }
                    } catch (obsError) {
                        console.error(`❌ Erro ao verificar OBS para ${login}:`, obsError);
                        // Sem transmissão ativa - mostrar "sem sinal"
                        videoUrl = '';
                        title = `Sem Transmissão - ${login}`;
                        isLive = false;
                    }
                }
            } catch (error) {
                console.error('Erro ao verificar transmissão do usuário:', error);
                videoUrl = '';
                title = 'Erro na Transmissão';
                isLive = false;
            }
        } else if (stream) {
            // Stream ao vivo
            const wowzaHost = 'stmv1.udicast.com';

            // Verificar se é stream de playlist ou OBS
            if (stream.includes('_playlist')) {
                // Stream de playlist - usar aplicação específica do usuário
                const userFromStream = stream.replace('_playlist', '');
                videoUrl = `http://${wowzaHost}:1935/samhost/smil:playlists_agendamentos.smil/playlist.m3u8`;
            } else {
                // Stream OBS - usar aplicação específica do usuário
                videoUrl = `http://${wowzaHost}:1935/samhost/${userLogin}_live/playlist.m3u8`;
            }
            title = `Stream: ${stream}`;
            isLive = true;
        }
        else if (userLogin && userLogin !== 'usuario') {
            // Playlist específica
            try {
                const wowzaHost = 'stmv1.udicast.com';

                // Definir URL padrão OBS
                videoUrl = `http://${wowzaHost}:80/${userLogin}/${userLogin}_live/playlist.m3u8`;

                // Buscar nome da playlist (se existir)
                const [rows] = await db.execute(
                    'SELECT nome FROM playlists WHERE id = ?',
                    [playlist]
                );

                if (rows.length > 0) {
                    title = `Playlist: ${rows[0].nome}`;
                } else {
                    title = `Stream OBS - ${userLogin}`;
                }

                isLive = true;
            } catch (error) {
                console.error('Erro ao buscar playlist específica:', error);
                videoUrl = '';
                title = `Erro na Playlist - ${playlist}`;
                isLive = false;
            }
        }


        if (playlistRows.length > 0) {
            try {
                title = `Playlist: ${playlistRows[0].nome}`;
                // Para playlist, usar o primeiro vídeo
                const [videoRows] = await db.execute(
                    'SELECT v.url, v.nome, v.caminho FROM videos v WHERE v.playlist_id = ? ORDER BY v.ordem_playlist ASC, v.id ASC LIMIT 1',
                    [playlist]
                );

                if (videoRows.length > 0) {
                    const video = videoRows[0];
                    let videoPath = video.url || video.caminho;

                    // Construir URL HLS do Wowza
                    if (videoPath && !videoPath.startsWith('http')) {
                        const cleanPath = videoPath.replace(/^\/?(home\/streaming\/|content\/|streaming\/)?/, '');
                        const pathParts = cleanPath.split('/');

                        if (pathParts.length >= 3) {
                            const userPath = pathParts[0];
                            const folderName = pathParts[1];
                            const fileName = pathParts[2];
                            const finalFileName = fileName.endsWith('.mp4') ? fileName : fileName.replace(/\.[^/.]+$/, '.mp4');

                            const wowzaHost = 'stmv1.udicast.com';
                            videoUrl = `http://${wowzaHost}:80/vod/_definst_/mp4:${userPath}/${folderName}/${finalFileName}/playlist.m3u8`;
                        } else {
                            videoUrl = `/content/${videoPath}`;
                        }
                    } else {
                        videoUrl = videoPath;
                    }

                    title = videoRows[0].nome;
                }
            } catch (error) {
                console.error('Erro ao carregar playlist:', error);
            }
        } else if (video) {
            try {
                const [videoRows] = await db.execute(
                    'SELECT url, nome, caminho FROM videos WHERE id = ?',
                    [video]
                );

                if (videoRows.length > 0) {
                    const videoData = videoRows[0];
                    let videoPath = videoData.url || videoData.caminho;

                    // Construir URL HLS do Wowza
                    if (videoPath && !videoPath.startsWith('http')) {
                        const cleanPath = videoPath.replace(/^\/?(home\/streaming\/|content\/|streaming\/)?/, '');
                        const pathParts = cleanPath.split('/');

                        if (pathParts.length >= 3) {
                            const userPath = pathParts[0];
                            const folderName = pathParts[1];
                            const fileName = pathParts[2];
                            const finalFileName = fileName.endsWith('.mp4') ? fileName : fileName.replace(/\.[^/.]+$/, '.mp4');

                            const wowzaHost = 'stmv1.udicast.com'; // SEMPRE usar domínio
                            videoUrl = `http://${wowzaHost}:80/vod/_definst_/mp4:${userPath}/${folderName}/${finalFileName}/playlist.m3u8`;
                        } else {
                            videoUrl = `/content/${videoPath}`;
                        }
                    } else {
                        videoUrl = videoPath;
                    }

                    title = videoRows[0].nome;
                }
            } catch (error) {
                console.error('Erro ao carregar vídeo:', error);
            }
        }


        console.log('🎬 Player URL construída:', {
            videoUrl,
            title,
            isLive,
            userLogin,
            hasPlaylistTransmission: false,
            hasOBSTransmission: false
        });

        // Gerar HTML do player
        const playerHTML = generatePlayerHTML({
            videoUrl,
            title,
            isLive,
            aspectRatio: aspectratio,
            autoplay: autoplay === 'true',
            muted: muted === 'true',
            loop: loop === 'true',
            showCounter: contador === 'true',
            showSharing: compartilhamento === 'true',
            playerType: parseInt(player) || parseInt(player_type) || 1,
            userLogin
        });

        console.log('✅ Enviando HTML do player');

        res.setHeader('Content-Type', 'text/html');
        res.send(playerHTML);

    } catch (error) {
        console.error('Erro no player iframe:', error);
        console.error('Stack trace:', error.stack);
        res.status(500).send(generateErrorHTML('Erro no Player', 'Não foi possível carregar o conteúdo solicitado.'));
    }
});

// Função para gerar HTML do player baseado no video.php
// Função para gerar o HTML do player
function generatePlayerHTML({
  videoUrl,
  title,
  aspectRatio = "16:9",
  autoplay = false,
  muted = false,
  loop = false,
  contador = false,
  compartilhamento = false,
  playerType = "html5",
  isLive = false,
}) {
  const autoplayAttr = autoplay ? "autoplay" : "";
  const mutedAttr = muted ? "muted" : "";
  const loopAttr = loop ? "loop" : "";

  if (playerType === "videojs") {
    return `
      <!DOCTYPE html>
      <html lang="pt-br">
      <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <link href="//vjs.zencdn.net/7.8.4/video-js.css" rel="stylesheet" />
        <style>
          body, html { margin:0; padding:0; height:100%; width:100%; background:black; }
          .video-js { height:100%; width:100%; }
        </style>
      </head>
      <body>
        <video id="player_webtv" class="video-js vjs-fluid vjs-default-skin"
          ${autoplayAttr} ${mutedAttr} ${loopAttr} controls preload="none"
          width="100%" height="100%"
          data-setup='{ "fluid":true,"aspectRatio":"${aspectRatio}" }'>
          <source src="${videoUrl}" type="application/x-mpegURL">
        </video>

        <script src="//vjs.zencdn.net/7.8.4/video.js"></script>
        <script src="//cdnjs.cloudflare.com/ajax/libs/videojs-contrib-hls/5.12.0/videojs-contrib-hls.min.js"></script>
        <script src="//cdnjs.cloudflare.com/ajax/libs/videojs-contrib-quality-levels/2.0.9/videojs-contrib-quality-levels.min.js"></script>
        <script src="//unpkg.com/videojs-hls-quality-selector@1.1.4/dist/videojs-hls-quality-selector.min.js"></script>

        <script>
          var player = videojs('player_webtv', {
            hls: { overrideNative: true }
          });
          player.hlsQualitySelector({ displayCurrentQuality: true });

          player.on("pause", function () {
            player.one("play", function () {
              player.load();
              player.play();
            });
          });

          ${isLive ? `
          player.on('error', function() {
            setTimeout(function() { location.reload(); }, 10000);
          });
          ` : ""}
        </script>
      </body>
      </html>
    `;
  }

  // Player HTML5 padrão
  return `
    <!DOCTYPE html>
    <html lang="pt-br">
    <head>
      <meta charset="utf-8">
      <title>${title}</title>
      <style>
        body, html { margin:0; padding:0; height:100%; width:100%; background:black; }
        video { width:100%; height:100%; }
      </style>
    </head>
    <body>
      <video ${autoplayAttr} ${mutedAttr} ${loopAttr} controls>
        <source src="${videoUrl}" type="application/x-mpegURL">
      </video>
    </body>
    </html>
  `;
}

// ==========================
// ROTA PRINCIPAL DO PLAYER
// ==========================
router.get("/iframe", async (req, res) => {
  try {
    const {
      stream,
      playlist,
      video,
      player_type = "html5",
      login,
      vod,
      aspectratio = "16:9",
      autoplay = "false",
      muted = "false",
      loop = "false",
      contador = "false",
      compartilhamento = "false",
      player = "1",
    } = req.query;

    let videoUrl = "";
    let title = "Player";
    let isLive = false;
    const userLogin = login || "usuario";

    const wowzaHost = "stmv1.udicast.com"; // sempre domínio

    // Caso VOD
    if (vod) {
      const parts = vod.split("/");
      if (parts.length >= 2) {
        const folder = parts[0];
        const file = parts[1].endsWith(".mp4")
          ? parts[1]
          : parts[1].replace(/\.[^/.]+$/, ".mp4");
        videoUrl = `http://${wowzaHost}:80/vod/_definst_/mp4:${userLogin}/${folder}/${file}/playlist.m3u8`;
      }
      title = `VOD: ${vod}`;
      isLive = false;
    }

    // Caso Stream OBS
    else if (stream) {
      videoUrl = `http://${wowzaHost}:80/${userLogin}/${userLogin}_live/playlist.m3u8`;
      title = `Stream OBS - ${userLogin}`;
      isLive = true;
    }

    // Caso Playlist
    else if (playlist) {
      const [rows] = await db.execute(
        "SELECT nome FROM playlists WHERE id = ?",
        [playlist]
      );

      if (rows.length > 0) {
        title = `Playlist: ${rows[0].nome}`;
        // Aqui você pode melhorar pegando o primeiro vídeo da playlist
      } else {
        title = `Playlist Offline - ${playlist}`;
      }

      videoUrl = `http://${wowzaHost}:80/${userLogin}/${userLogin}_live/playlist.m3u8`;
      isLive = true;
    }

    // Fallback padrão OBS
    else {
      videoUrl = `http://${wowzaHost}:80/${userLogin}/${userLogin}_live/playlist.m3u8`;
      title = `Stream OBS - ${userLogin}`;
      isLive = true;
    }

    const html = generatePlayerHTML({
      videoUrl,
      title,
      aspectRatio: aspectratio,
      autoplay: autoplay === "true",
      muted: muted === "true",
      loop: loop === "true",
      contador: contador === "true",
      compartilhamento: compartilhamento === "true",
      playerType: player_type,
      isLive,
    });

    res.send(html);
  } catch (err) {
    console.error("Erro no player iframe:", err);
    res.status(500).send("Erro ao carregar player");
  }
});

module.exports = router;