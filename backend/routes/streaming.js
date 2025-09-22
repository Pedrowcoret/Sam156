const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');
const SSHManager = require('../config/SSHManager');
const { spawn } = require('child_process');

const router = express.Router();

// Mapa de processos ativos de transmissão
const activeTransmissions = new Map();

// Plataformas disponíveis com URLs RTMP corretas
const platforms = [
  {
    id: 'youtube',
    nome: 'YouTube',
    rtmp_base_url: 'rtmp://a.rtmp.youtube.com/live2/',
    requer_stream_key: true,
    supports_https: false
  },
  {
    id: 'facebook',
    nome: 'Facebook',
    rtmp_base_url: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    requer_stream_key: true,
    supports_https: true
  },
  {
    id: 'twitch',
    nome: 'Twitch',
    rtmp_base_url: 'rtmp://live-dfw.twitch.tv/app/',
    requer_stream_key: true,
    supports_https: false
  },
  {
    id: 'periscope',
    nome: 'Periscope',
    rtmp_base_url: 'rtmp://ca.pscp.tv:80/x/',
    requer_stream_key: true,
    supports_https: false
  },
  {
    id: 'vimeo',
    nome: 'Vimeo',
    rtmp_base_url: 'rtmp://rtmp.cloud.vimeo.com/live/',
    requer_stream_key: true,
    supports_https: false
  },
  {
    id: 'steam',
    nome: 'Steam Valve',
    rtmp_base_url: 'rtmp://ingest-any-ord1.broadcast.steamcontent.com/app/',
    requer_stream_key: true,
    supports_https: false
  },
  {
    id: 'tiktok',
    nome: 'TikTok',
    rtmp_base_url: 'rtmp://live.tiktok.com/live/',
    requer_stream_key: true,
    supports_https: false,
    special_config: 'vertical_crop'
  },
  {
    id: 'kwai',
    nome: 'Kwai',
    rtmp_base_url: 'rtmp://live.kwai.com/live/',
    requer_stream_key: true,
    supports_https: false,
    special_config: 'vertical_crop'
  },
  {
    id: 'custom',
    nome: 'RTMP Próprio/Custom',
    rtmp_base_url: 'rtmp://...',
    requer_stream_key: true,
    supports_https: false
  }
];

// Verificar se tabela transmissoes existe
router.use(async (req, res, next) => {
  try {
    await db.execute('DESCRIBE transmissoes');
    next();
  } catch (error) {
    // Tabela não existe, criar
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS transmissoes (
          codigo INT AUTO_INCREMENT PRIMARY KEY,
          codigo_stm INT NOT NULL,
          titulo VARCHAR(255) NOT NULL,
          descricao TEXT,
          codigo_playlist INT,
          status ENUM('ativa','pausada','finalizada') DEFAULT 'ativa',
          data_inicio DATETIME DEFAULT CURRENT_TIMESTAMP,
          data_fim DATETIME NULL,
          gravacao_ativa TINYINT(1) DEFAULT 0,
          loop_playlist TINYINT(1) DEFAULT 1,
          use_smil TINYINT(1) DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_codigo_stm (codigo_stm),
          INDEX idx_status (status),
          INDEX idx_playlist (codigo_playlist)
        )
      `);
      console.log('✅ Tabela transmissoes criada com sucesso');
      next();
    } catch (createError) {
      console.error('Erro ao criar tabela transmissoes:', createError);
      res.status(500).json({ error: 'Erro ao inicializar tabela de transmissões' });
    }
  }
});

// GET /api/streaming/platforms - Lista plataformas disponíveis
router.get('/platforms', authMiddleware, async (req, res) => {
  try {
    res.json({
      success: true,
      platforms: platforms
    });
  } catch (error) {
    console.error('Erro ao buscar plataformas:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// GET /api/streaming/lives - Lista transmissões do usuário
router.get('/lives', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await db.execute(
      `SELECT 
        codigo as id,
        data_inicio,
        data_fim,
        tipo,
        servidor_stm,
        servidor_live,
        status,
        DATE_FORMAT(data_inicio, '%d/%m/%Y %H:%i:%s') as data_inicio_formatted,
        DATE_FORMAT(data_fim, '%d/%m/%Y %H:%i:%s') as data_fim_formatted
       FROM lives 
       WHERE codigo_stm = ?
       ORDER BY data_inicio DESC`,
      [userId]
    );

    // Calcular duração e status para cada transmissão
    const lives = rows.map(live => {
      const now = new Date();
      const dataInicio = new Date(live.data_inicio);
      const dataFim = new Date(live.data_fim);
      
      let duracao = '0s';
      let statusText = 'Finalizado';
      
      if (live.status === '1') {
        // Transmitindo - calcular duração desde o início
        const diffMs = now.getTime() - dataInicio.getTime();
        duracao = formatDuration(Math.floor(diffMs / 1000));
        statusText = 'Transmitindo';
      } else if (live.status === '2') {
        duracao = '0s';
        statusText = 'Agendado';
      } else if (live.status === '3') {
        duracao = '0s';
        statusText = 'Erro';
      } else {
        // Finalizado - calcular duração total
        const diffMs = dataFim.getTime() - dataInicio.getTime();
        duracao = formatDuration(Math.floor(diffMs / 1000));
        statusText = 'Finalizado';
      }

      return {
        ...live,
        duracao,
        status_text: statusText,
        platform_name: platforms.find(p => p.id === live.tipo)?.nome || live.tipo
      };
    });

    res.json({
      success: true,
      lives: lives
    });
  } catch (error) {
    console.error('Erro ao buscar transmissões:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/streaming/start-live - Iniciar transmissão seguindo padrão PHP
router.post('/start-live', authMiddleware, async (req, res) => {
  try {
    const {
      tipo,
      servidor_rtmp,
      servidor_rtmp_chave,
      servidor_stm,
      data_inicio,
      data_fim,
      inicio_imediato
    } = req.body;

    const userId = req.user.id;
    const userLogin = req.user.usuario || (req.user.email ? req.user.email.split('@')[0] : `user_${userId}`);

    // Validações
    if (!servidor_rtmp || !servidor_rtmp_chave || !data_fim) {
      return res.status(400).json({
        success: false,
        error: 'Servidor RTMP, chave e data fim são obrigatórios'
      });
    }

    // Construir URL completa do servidor live
    const servidor_live = servidor_rtmp.endsWith('/') ? 
      `${servidor_rtmp}${servidor_rtmp_chave}` : 
      `${servidor_rtmp}/${servidor_rtmp_chave}`;

    // Converter datas do formato brasileiro para MySQL
    const dataInicioMySQL = data_inicio ? 
      data_inicio.replace(/(\d{2})\/(\d{2})\/(\d{4})\s(.*)/, '$3-$2-$1 $4') + ':00' : 
      new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    const dataFimMySQL = data_fim.replace(/(\d{2})\/(\d{2})\/(\d{4})\s(.*)/, '$3-$2-$1 $4') + ':00';

    // Buscar dados do servidor
    const [serverRows] = await db.execute(
      'SELECT servidor_id FROM folders WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;

    // Inserir transmissão na tabela lives
    const [result] = await db.execute(
      `INSERT INTO lives (
        codigo_stm, data_inicio, data_fim, tipo, servidor_stm, servidor_live, status
      ) VALUES (?, ?, ?, ?, ?, ?, '2')`,
      [userId, dataInicioMySQL, dataFimMySQL, tipo, servidor_stm, servidor_live]
    );

    const codigoLive = result.insertId;

    // Se início imediato, iniciar transmissão agora
    if (inicio_imediato === 'sim') {
      try {
        console.log(`🚀 Iniciando transmissão imediata para ${userLogin} - Live ID: ${codigoLive}`);
        
        // Construir comando FFmpeg baseado no tipo de plataforma
        let ffmpegCommand;
        
        if (tipo === 'facebook') {
          // Facebook usa configuração especial
          ffmpegCommand = `/usr/local/bin/ffmpeg -re -i "${servidor_stm}" -c:v copy -c:a copy -bsf:a aac_adtstoasc -preset ultrafast -strict experimental -threads 1 -f flv "${servidor_live}"`;
        } else if (tipo === 'tiktok' || tipo === 'kwai') {
          // TikTok/Kwai usa crop vertical 9:16
          ffmpegCommand = `/usr/local/bin/ffmpeg -re -i "${servidor_stm}" -vf 'crop=ih*(9/16):ih' -crf 21 -r 24 -g 48 -b:v 3000000 -b:a 128k -ar 44100 -acodec aac -vcodec libx264 -preset ultrafast -bufsize '(6.000*3000000)/8' -maxrate 3500000 -threads 1 -f flv "${servidor_live}"`;
        } else {
          // Outras plataformas usam configuração padrão
          ffmpegCommand = `/usr/local/bin/ffmpeg -re -i "${servidor_stm}" -c:v copy -c:a copy -bsf:a aac_adtstoasc -preset ultrafast -strict experimental -threads 1 -f flv "${servidor_live}"`;
        }

        // Executar comando via SSH usando screen session
        const screenCommand = `screen -dmS ${userLogin}_${codigoLive} bash -c "${ffmpegCommand}; exec sh"`;
        
        console.log(`📋 Comando screen: ${screenCommand}`);
        
        await SSHManager.executeCommand(serverId, `echo OK; ${screenCommand}`);
        
        // Aguardar 5 segundos para processo inicializar
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Verificar se processo está rodando
        const checkCommand = `/bin/ps aux | /bin/grep ffmpeg | /bin/grep rtmp | /bin/grep ${userLogin} | /bin/grep ${tipo} | /usr/bin/wc -l`;
        const checkResult = await SSHManager.executeCommand(serverId, checkCommand);
        
        const processCount = parseInt(checkResult.stdout.trim()) || 0;
        
        if (processCount > 0) {
          // Transmissão iniciada com sucesso
          await db.execute(
            'UPDATE lives SET status = "1", data_inicio = NOW() WHERE codigo = ?',
            [codigoLive]
          );

          console.log(`✅ Transmissão iniciada com sucesso - Live ID: ${codigoLive}, Processos: ${processCount}`);

          res.json({
            success: true,
            message: 'Live iniciada com sucesso',
            live_id: codigoLive,
            status: 'transmitindo',
            processo_count: processCount,
            comando_executado: ffmpegCommand,
            screen_session: `${userLogin}_${codigoLive}`
          });
        } else {
          // Erro ao iniciar transmissão
          await db.execute(
            'UPDATE lives SET status = "3" WHERE codigo = ?',
            [codigoLive]
          );

          console.error(`❌ Erro ao iniciar transmissão - Live ID: ${codigoLive}, Processos encontrados: ${processCount}`);

          res.status(500).json({
            success: false,
            error: 'Erro ao iniciar live, tente novamente',
            debug_info: {
              live_id: codigoLive,
              processo_count: processCount,
              comando_executado: ffmpegCommand,
              check_command: checkCommand,
              check_result: checkResult.stdout
            }
          });
        }
      } catch (sshError) {
        console.error('Erro SSH ao iniciar transmissão:', sshError);
        
        // Marcar como erro no banco
        await db.execute(
          'UPDATE lives SET status = "3" WHERE codigo = ?',
          [codigoLive]
        );

        res.status(500).json({
          success: false,
          error: 'Erro ao conectar com servidor para iniciar transmissão',
          details: sshError.message
        });
      }
    } else {
      // Transmissão agendada
      res.json({
        success: true,
        message: 'Live agendada com sucesso',
        live_id: codigoLive,
        status: 'agendado'
      });
    }

  } catch (error) {
    console.error('Erro ao criar transmissão:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/streaming/stop-live/:id - Finalizar transmissão
router.post('/stop-live/:id', authMiddleware, async (req, res) => {
  try {
    const liveId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.usuario || (req.user.email ? req.user.email.split('@')[0] : `user_${userId}`);

    // Buscar dados da transmissão
    const [liveRows] = await db.execute(
      'SELECT * FROM lives WHERE codigo = ? AND codigo_stm = ?',
      [liveId, userId]
    );

    if (liveRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Transmissão não encontrada'
      });
    }

    const live = liveRows[0];

    // Buscar servidor do usuário
    const [serverRows] = await db.execute(
      'SELECT servidor_id FROM folders WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;

    try {
      // Finalizar screen session via SSH
      const killCommand = `screen -ls | grep -o '[0-9]*\\.${userLogin}_${liveId}\\>' | xargs -I{} screen -X -S {} quit`;
      
      console.log(`🛑 Finalizando transmissão: ${killCommand}`);
      
      await SSHManager.executeCommand(serverId, `echo OK; ${killCommand}`);
      
      // Atualizar status no banco
      await db.execute(
        'UPDATE lives SET status = "0", data_fim = NOW() WHERE codigo = ?',
        [liveId]
      );

      // Remover do mapa de transmissões ativas
      activeTransmissions.delete(`${userId}_${liveId}`);

      console.log(`✅ Transmissão finalizada - Live ID: ${liveId}`);

      res.json({
        success: true,
        message: `Live finalizada com sucesso. Agora você deve finalizar a transmissão na sua conta do ${live.tipo}`,
        live_id: liveId,
        platform: live.tipo
      });

    } catch (sshError) {
      console.error('Erro SSH ao finalizar transmissão:', sshError);
      res.status(500).json({
        success: false,
        error: 'Erro ao finalizar transmissão no servidor',
        details: sshError.message
      });
    }

  } catch (error) {
    console.error('Erro ao finalizar transmissão:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// DELETE /api/streaming/remove-live/:id - Remover transmissão
router.delete('/remove-live/:id', authMiddleware, async (req, res) => {
  try {
    const liveId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.usuario || (req.user.email ? req.user.email.split('@')[0] : `user_${userId}`);

    // Buscar dados da transmissão
    const [liveRows] = await db.execute(
      'SELECT * FROM lives WHERE codigo = ? AND codigo_stm = ?',
      [liveId, userId]
    );

    if (liveRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Transmissão não encontrada'
      });
    }

    const live = liveRows[0];

    // Buscar servidor do usuário
    const [serverRows] = await db.execute(
      'SELECT servidor_id FROM folders WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;

    try {
      // Finalizar screen session se estiver ativa
      const killCommand = `screen -ls | grep -o '[0-9]*\\.${userLogin}_${liveId}\\>' | xargs -I{} screen -X -S {} quit`;
      
      console.log(`🗑️ Removendo transmissão: ${killCommand}`);
      
      await SSHManager.executeCommand(serverId, `echo OK; ${killCommand}`);
      
      // Remover do banco
      await db.execute(
        'DELETE FROM lives WHERE codigo = ?',
        [liveId]
      );

      // Remover do mapa de transmissões ativas
      activeTransmissions.delete(`${userId}_${liveId}`);

      console.log(`✅ Transmissão removida - Live ID: ${liveId}`);

      res.json({
        success: true,
        message: 'Live removida com sucesso',
        live_id: liveId
      });

    } catch (sshError) {
      console.error('Erro SSH ao remover transmissão:', sshError);
      res.status(500).json({
        success: false,
        error: 'Erro ao remover transmissão no servidor',
        details: sshError.message
      });
    }

  } catch (error) {
    console.error('Erro ao remover transmissão:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// GET /api/streaming/status - Status geral das transmissões
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const userLogin = req.user.usuario || (req.user.email ? req.user.email.split('@')[0] : `user_${userId}`);

    // Verificar se response já foi enviado
    let responseSent = false;
    const sendResponse = (data) => {
      if (!responseSent) {
        responseSent = true;
        res.json(data);
      }
    };
    // Verificar transmissões de playlist ativas
    const [activeRows] = await db.execute(
      'SELECT t.*, p.nome as playlist_nome FROM transmissoes t LEFT JOIN playlists p ON t.codigo_playlist = p.id WHERE t.codigo_stm = ? AND t.status = "ativa" ORDER BY t.data_inicio DESC LIMIT 1',
      [userId]
    );

    if (activeRows.length > 0) {
      const activeTransmission = activeRows[0];
      const now = new Date();
      const dataInicio = new Date(activeTransmission.data_inicio);
      const diffMs = now.getTime() - dataInicio.getTime();
      const uptime = formatDuration(Math.floor(diffMs / 1000));

      sendResponse({
        success: true,
        is_live: true,
        stream_type: 'playlist',
        transmission: {
          id: activeTransmission.codigo,
          titulo: activeTransmission.titulo,
          codigo_playlist: activeTransmission.codigo_playlist,
          playlist_nome: activeTransmission.playlist_nome,
          data_inicio: activeTransmission.data_inicio,
          data_fim: activeTransmission.data_fim,
          stats: {
            viewers: Math.floor(Math.random() * 50) + 10, // Simular espectadores
            bitrate: 2500,
            uptime: uptime,
            isActive: true
          }
        }
      });
      return;
    } else {
      // Verificar transmissões OBS (lives)
      const [obsRows] = await db.execute(
        'SELECT * FROM lives WHERE codigo_stm = ? AND status = "1" ORDER BY data_inicio DESC LIMIT 1',
        [userId]
      );

      if (obsRows.length > 0) {
        const obsLive = obsRows[0];
        const now = new Date();
        const dataInicio = new Date(obsLive.data_inicio);
        const diffMs = now.getTime() - dataInicio.getTime();
        const uptime = formatDuration(Math.floor(diffMs / 1000));

        sendResponse({
          success: true,
          is_live: true,
          stream_type: 'obs',
          obs_stream: {
            is_live: true,
            viewers: Math.floor(Math.random() * 30) + 5,
            bitrate: 2500,
            uptime: uptime,
            recording: false
          }
        });
        return;
      } else {
        // Nenhuma transmissão ativa - limpar transmissões órfãs
        await cleanupInactiveTransmissions(userId);
        
        sendResponse({
          success: true,
          is_live: false,
          stream_type: null,
          transmission: null
        });
        return;
      }
    }
  } catch (error) {
    console.error('Erro ao verificar status:', error);
    if (!responseSent) {
      res.status(500).json({ success: false, error: 'Erro interno do servidor' });
    }
  }
});
// GET /api/streaming/wowza-debug - Debug da API Wowza (admin)
router.get('/wowza-debug', authMiddleware, async (req, res) => {
  try {
    // Verificar se usuário tem permissão (apenas revendas)
    if (req.user.tipo !== 'revenda') {
      return res.status(403).json({
        success: false,
        error: 'Acesso negado. Apenas revendas podem acessar informações de debug.'
      });
    }

    const WowzaStreamingService = require('../config/WowzaStreamingService');
    
    // Testar conexão
    const connectionTest = await WowzaStreamingService.testConnection();
    
    // Listar todos os incoming streams
    const allStreams = await WowzaStreamingService.listAllIncomingStreams();
    
    res.json({
      success: true,
      connection_test: connectionTest,
      all_streams: allStreams,
      wowza_config: {
        baseUrl: WowzaStreamingService.baseUrl,
        username: WowzaStreamingService.username,
        application: WowzaStreamingService.application,
        initialized: WowzaStreamingService.initialized
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro no debug Wowza:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro interno do servidor',
      details: error.message
    });
  }
});

// POST /api/streaming/start - Iniciar transmissão de playlist
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const {
      titulo,
      descricao,
      playlist_id,
      platform_ids = [],
      enable_recording = false,
      use_smil = true,
      loop_playlist = true
    } = req.body;

    const userId = req.user.id;
    const userLogin = req.user.usuario || (req.user.email ? req.user.email.split('@')[0] : `user_${userId}`);

    if (!titulo || !playlist_id) {
      return res.status(400).json({
        success: false,
        error: 'Título e playlist são obrigatórios'
      });
    }

    // Verificar se playlist existe e tem vídeos
    const [playlistRows] = await db.execute(
      'SELECT id, nome, total_videos FROM playlists WHERE id = ? AND codigo_stm = ?',
      [playlist_id, userId]
    );

    if (playlistRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Playlist não encontrada'
      });
    }

    const playlist = playlistRows[0];
    if (playlist.total_videos === 0) {
      return res.status(400).json({
        success: false,
        error: 'A playlist deve ter pelo menos um vídeo'
      });
    }

    // Verificar se já há transmissão ativa
    const [activeTransmission] = await db.execute(
      'SELECT codigo FROM transmissoes WHERE codigo_stm = ? AND status = "ativa"',
      [userId]
    );

    if (activeTransmission.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Já existe uma transmissão ativa. Finalize-a antes de iniciar uma nova.'
      });
    }

    // Inserir nova transmissão
    const [result] = await db.execute(
      `INSERT INTO transmissoes (
        codigo_stm, titulo, descricao, codigo_playlist, status, data_inicio, 
        gravacao_ativa, loop_playlist, use_smil
      ) VALUES (?, ?, ?, ?, 'ativa', NOW(), ?, ?, ?)`,
      [userId, titulo, descricao || '', playlist_id, enable_recording ? 1 : 0, loop_playlist ? 1 : 0, use_smil ? 1 : 0]
    );

    const transmissionId = result.insertId;

    // Atualizar arquivo SMIL do usuário
    try {
      const [serverRows] = await db.execute(
        'SELECT servidor_id FROM folders WHERE user_id = ? LIMIT 1',
        [userId]
      );
      const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;
      
      const PlaylistSMILService = require('../services/PlaylistSMILService');
      await PlaylistSMILService.updateUserSMIL(userId, userLogin, serverId);
      console.log(`✅ Arquivo SMIL atualizado para transmissão da playlist ${playlist_id}`);
    } catch (smilError) {
      console.warn('Erro ao atualizar arquivo SMIL:', smilError.message);
    }

    // URLs do player
    const wowzaHost = 'stmv1.udicast.com';
    const playerUrls = {
      hls: `http://${wowzaHost}:1935/samhost/smil:playlists_agendamentos.smil/playlist.m3u8`,
      hls_http: `http://${wowzaHost}/samhost/smil:playlists_agendamentos.smil/playlist.m3u8`,
      rtmp: `rtmp://${wowzaHost}:1935/samhost/smil:playlists_agendamentos.smil`,
      rtsp: `rtsp://${wowzaHost}:554/samhost/smil:playlists_agendamentos.smil`,
      dash: `http://${wowzaHost}:1935/samhost/smil:playlists_agendamentos.smil/manifest.mpd`
    };

    console.log(`✅ Transmissão de playlist iniciada - ID: ${transmissionId}, Playlist: ${playlist.nome}`);

    res.json({
      success: true,
      message: `Transmissão da playlist "${playlist.nome}" iniciada com sucesso`,
      transmission: {
        id: transmissionId,
        titulo,
        codigo_playlist: playlist_id,
        playlist_nome: playlist.nome,
        status: 'ativa',
        data_inicio: new Date().toISOString(),
        stats: {
          viewers: 0,
          bitrate: 2500,
          uptime: '00:00:00',
          isActive: true
        }
      },
      player_urls: playerUrls,
      wowza_data: {
        rtmpUrl: `rtmp://${wowzaHost}:1935/samhost`,
        streamName: userLogin,
        hlsUrl: playerUrls.hls,
        bitrate: 2500
      }
    });
  } catch (error) {
    console.error('Erro ao iniciar transmissão:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/streaming/stop - Parar transmissão
router.post('/stop', authMiddleware, async (req, res) => {
  try {
    const { transmission_id, stream_type } = req.body;
    const userId = req.user.id;
    const userLogin = req.user.usuario || (req.user.email ? req.user.email.split('@')[0] : `user_${userId}`);

    // Verificar se response já foi enviado
    let responseSent = false;
    const sendResponse = (data) => {
      if (!responseSent) {
        responseSent = true;
        res.json(data);
      }
    };
    if (stream_type === 'playlist' || !stream_type) {
      // Parar transmissão de playlist
      const [transmissionRows] = await db.execute(
        'SELECT codigo FROM transmissoes WHERE codigo_stm = ? AND status = "ativa"',
        [userId]
      );

      if (transmissionRows.length > 0) {
        const transmissionId = transmission_id || transmissionRows[0].codigo;
        
        // Atualizar status da transmissão
        await db.execute(
          'UPDATE transmissoes SET status = "finalizada", data_fim = NOW() WHERE codigo = ?',
          [transmissionId]
        );

        console.log(`✅ Transmissão de playlist finalizada - ID: ${transmissionId}`);

        sendResponse({
          success: true,
          message: 'Transmissão de playlist finalizada com sucesso'
        });
      } else {
        sendResponse({
          success: true,
          message: 'Nenhuma transmissão de playlist ativa encontrada'
        });
      }

    } else if (stream_type === 'obs') {
      // Parar transmissão OBS
      const [obsRows] = await db.execute(
        'SELECT codigo FROM lives WHERE codigo_stm = ? AND status = "1"',
        [userId]
      );

      if (obsRows.length > 0) {
        const liveId = transmission_id || obsRows[0].codigo;
        
        // Atualizar status da live
        await db.execute(
          'UPDATE lives SET status = "0", data_fim = NOW() WHERE codigo = ?',
          [liveId]
        );

        console.log(`✅ Transmissão OBS finalizada - ID: ${liveId}`);
        sendResponse({
          success: true,
          message: 'Transmissão OBS finalizada com sucesso'
        });
      } else {
        sendResponse({
          success: true,
          message: 'Nenhuma transmissão OBS ativa encontrada'
        });
      }
    } else {
      sendResponse({
        success: true,
        message: 'Nenhuma transmissão ativa encontrada'
      });
    }
  } catch (error) {
    console.error('Erro ao parar transmissão:', error);
    if (!responseSent) {
      res.status(500).json({ success: false, error: 'Erro interno do servidor' });
    }
  }
});

// GET /api/streaming/source-urls - URLs de fonte para transmissão
router.get('/source-urls', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const userLogin = req.user.usuario || (req.user.email ? req.user.email.split('@')[0] : `user_${userId}`);

    // SEMPRE usar domínio do Wowza
    const wowzaHost = 'stmv1.udicast.com';
    
    const sourceUrls = {
      http_m3u8: `https://${wowzaHost}/${userLogin}/${userLogin}/playlist.m3u8`,
      rtmp: `rtmp://${wowzaHost}:1935/${userLogin}`,
      recommended: 'http_m3u8'
    };

    res.json({
      success: true,
      source_urls: sourceUrls,
      user_login: userLogin,
      wowza_host: wowzaHost
    });

  } catch (error) {
    console.error('Erro ao obter URLs de fonte:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// Função auxiliar para formatar duração
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  } else if (m > 0) {
    return `${m}m ${s}s`;
  } else {
    return `${s}s`;
  }
}

// Função para limpar transmissões inativas
async function cleanupInactiveTransmissions(userId) {
  try {
    // Finalizar transmissões de playlist órfãs
    const [playlistResult] = await db.execute(
      'UPDATE transmissoes SET status = "finalizada", data_fim = NOW() WHERE codigo_stm = ? AND status = "ativa"',
      [userId]
    );
    
    // Finalizar lives órfãs
    const [livesResult] = await db.execute(
      'UPDATE lives SET status = "0", data_fim = NOW() WHERE codigo_stm = ? AND status = "1"',
      [userId]
    );
    
    const totalCleaned = (playlistResult.affectedRows || 0) + (livesResult.affectedRows || 0);
    
    if (totalCleaned > 0) {
      console.log(`🧹 Limpeza automática: ${totalCleaned} transmissões inativas finalizadas para usuário ${userId}`);
    }
    
    return { success: true, cleaned_count: totalCleaned };
  } catch (error) {
    console.error('Erro na limpeza de transmissões inativas:', error);
    return { success: false, error: error.message };
  }
}

// POST /api/streaming/cleanup-inactive - Limpar transmissões inativas
router.post('/cleanup-inactive', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await cleanupInactiveTransmissions(userId);
    res.json(result);
  } catch (error) {
    console.error('Erro na limpeza:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// Cleanup ao fechar aplicação
process.on('SIGINT', async () => {
  console.log('\n🛑 Finalizando todas as transmissões ativas...');
  
  for (const [key, transmissionData] of activeTransmissions) {
    try {
      const [userId, liveId] = key.split('_');
      
      // Finalizar screen session
      const [userRows] = await db.execute(
        'SELECT usuario, email FROM streamings WHERE codigo_cliente = ? LIMIT 1',
        [userId]
      );
      
      if (userRows.length > 0) {
        const userLogin = userRows[0].usuario || userRows[0].email.split('@')[0];
        
        const [serverRows] = await db.execute(
          'SELECT servidor_id FROM folders WHERE user_id = ? LIMIT 1',
          [userId]
        );
        const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;
        
        const killCommand = `screen -ls | grep -o '[0-9]*\\.${userLogin}_${liveId}\\>' | xargs -I{} screen -X -S {} quit`;
        await SSHManager.executeCommand(serverId, `echo OK; ${killCommand}`);
        
        // Atualizar status no banco
        await db.execute(
          'UPDATE lives SET status = "0", data_fim = NOW() WHERE codigo = ?',
          [liveId]
        );
      }
    } catch (error) {
      console.error(`Erro ao finalizar transmissão ${key}:`, error);
    }
  }
  
  activeTransmissions.clear();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Finalizando todas as transmissões ativas...');
  
  for (const [key, transmissionData] of activeTransmissions) {
    try {
      const [userId, liveId] = key.split('_');
      
      const [userRows] = await db.execute(
        'SELECT usuario, email FROM streamings WHERE codigo_cliente = ? LIMIT 1',
        [userId]
      );
      
      if (userRows.length > 0) {
        const userLogin = userRows[0].usuario || userRows[0].email.split('@')[0];
        
        const [serverRows] = await db.execute(
          'SELECT servidor_id FROM folders WHERE user_id = ? LIMIT 1',
          [userId]
        );
        const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;
        
        const killCommand = `screen -ls | grep -o '[0-9]*\\.${userLogin}_${liveId}\\>' | xargs -I{} screen -X -S {} quit`;
        await SSHManager.executeCommand(serverId, `echo OK; ${killCommand}`);
        
        await db.execute(
          'UPDATE lives SET status = "0", data_fim = NOW() WHERE codigo = ?',
          [liveId]
        );
      }
    } catch (error) {
      console.error(`Erro ao finalizar transmissão ${key}:`, error);
    }
  }
  
  activeTransmissions.clear();
  process.exit(0);
});

module.exports = router;