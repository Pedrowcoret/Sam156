import React, { useRef, useEffect, useState } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, AlertCircle, RotateCcw, ExternalLink, Activity, Eye, Clock, Wifi, WifiOff } from 'lucide-react';

interface VideoJSStreamingPlayerProps {
  src?: string;
  title?: string;
  isLive?: boolean;
  autoplay?: boolean;
  muted?: boolean;
  controls?: boolean;
  className?: string;
  onReady?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onError?: (error: any) => void;
  streamStats?: {
    viewers?: number;
    bitrate?: number;
    uptime?: string;
    quality?: string;
    isRecording?: boolean;
  };
  watermark?: {
    url: string;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    opacity: number;
  };
}

declare global {
  interface Window {
    videojs: any;
  }
}

const VideoJSStreamingPlayer: React.FC<VideoJSStreamingPlayerProps> = ({
  src,
  title,
  isLive = false,
  autoplay = false,
  muted = false,
  controls = true,
  className = '',
  onReady,
  onPlay,
  onPause,
  onError,
  streamStats,
  watermark
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const [retryCount, setRetryCount] = useState(0);
  const [showStats, setShowStats] = useState(false);
  const maxRetries = 3;

  // Cleanup function
  const cleanupPlayer = () => {
    if (playerRef.current) {
      try {
        if (typeof playerRef.current.dispose === 'function') {
          playerRef.current.dispose();
        }
        playerRef.current = null;
        setIsPlayerReady(false);
        console.log('✅ Video.js player limpo');
      } catch (error) {
        console.warn('Erro ao limpar Video.js player:', error);
        playerRef.current = null;
        setIsPlayerReady(false);
      }
    }
  };

  // Carregar Video.js dinamicamente
  useEffect(() => {
    const loadVideoJS = async () => {
      if (window.videojs) {
        initializePlayer();
        return;
      }

      try {
        // Carregar CSS do Video.js
        if (!document.querySelector('link[href*="video-js.css"]')) {
          const cssLink = document.createElement('link');
          cssLink.rel = 'stylesheet';
          cssLink.href = 'https://vjs.zencdn.net/8.10.0/video-js.css';
          document.head.appendChild(cssLink);
        }

        // Carregar JavaScript do Video.js
        if (!document.querySelector('script[src*="video.min.js"]')) {
          const script = document.createElement('script');
          script.src = 'https://vjs.zencdn.net/8.10.0/video.min.js';
          script.onload = () => {
            // Carregar plugin HLS
            if (!document.querySelector('script[src*="videojs-http-streaming"]')) {
              const hlsScript = document.createElement('script');
              hlsScript.src = 'https://cdn.jsdelivr.net/npm/@videojs/http-streaming@3.0.2/dist/videojs-http-streaming.min.js';
              hlsScript.onload = () => initializePlayer();
              hlsScript.onerror = () => {
                setError('Erro ao carregar plugin HLS');
                setLoading(false);
              };
              document.head.appendChild(hlsScript);
            } else {
              initializePlayer();
            }
          };
          script.onerror = () => {
            setError('Erro ao carregar Video.js');
            setLoading(false);
          };
          document.head.appendChild(script);
        } else {
          initializePlayer();
        }
      } catch (error) {
        console.error('Erro ao carregar Video.js:', error);
        setError('Erro ao carregar player');
        setLoading(false);
      }
    };

    const initializePlayer = () => {
      if (!videoRef.current || !window.videojs) return;

      try {
        setLoading(true);
        setError(null);

        console.log('🎥 Inicializando Video.js player para streaming...');

        const player = window.videojs(videoRef.current, {
          controls: controls,
          responsive: true,
          fluid: true,
          playbackRates: [0.5, 1, 1.25, 1.5, 2],
          html5: {
            hls: {
              overrideNative: true,
              enableLowInitialPlaylist: isLive,
              smoothQualityChange: true,
              handlePartialData: true
            },
            vhs: {
              overrideNative: true,
              withCredentials: false
            }
          },
          liveui: isLive,
          liveTracker: isLive ? {
            trackingThreshold: 20,
            liveTolerance: 15
          } : false,
          inactivityTimeout: 0,
          userActions: {
            hotkeys: true
          }
        });

        playerRef.current = player;

        player.ready(() => {
          console.log('✅ Video.js streaming player pronto');
          setIsPlayerReady(true);
          setLoading(false);
          setRetryCount(0);
          
          if (onReady) onReady();
          
          // Configurar fonte se disponível
          if (src) {
            setTimeout(() => updatePlayerSource(), 100);
          }
        });

        // Event listeners
        player.on('play', () => {
          console.log('▶️ Video.js streaming play');
          setConnectionStatus('connected');
          if (onPlay) onPlay();
        });

        player.on('pause', () => {
          console.log('⏸️ Video.js streaming pause');
          if (onPause) onPause();
        });

        player.on('error', (e: any) => {
          console.error('❌ Video.js streaming error:', e);
          const errorObj = player.error();
          
          let errorMessage = 'Erro ao carregar stream';
          if (errorObj) {
            switch (errorObj.code) {
              case 1: errorMessage = 'Reprodução abortada'; break;
              case 2: errorMessage = 'Erro de rede - Verifique se a transmissão está ativa'; break;
              case 3: errorMessage = 'Erro de decodificação'; break;
              case 4: errorMessage = 'Stream não suportado ou offline'; break;
              default: errorMessage = errorObj.message || 'Stream offline ou inacessível';
            }
          }
          
          setError(errorMessage);
          setLoading(false);
          setConnectionStatus('disconnected');
          
          if (onError) onError(e);
        });

        player.on('loadstart', () => {
          setLoading(true);
          setError(null);
          setConnectionStatus('connecting');
        });

        player.on('canplay', () => {
          setLoading(false);
          setConnectionStatus('connected');
        });

        player.on('waiting', () => {
          setLoading(true);
        });

        player.on('playing', () => {
          setLoading(false);
          setConnectionStatus('connected');
        });

      } catch (error) {
        console.error('Erro ao inicializar Video.js:', error);
        setError('Erro ao inicializar player');
        setLoading(false);
        
        if (retryCount < maxRetries) {
          console.log(`🔄 Tentativa ${retryCount + 1}/${maxRetries} de reinicializar...`);
          setRetryCount(prev => prev + 1);
          setTimeout(() => {
            cleanupPlayer();
            initializePlayer();
          }, 2000);
        }
      }
    };

    loadVideoJS();

    return () => {
      cleanupPlayer();
    };
  }, []);

  // Atualizar fonte quando src mudar
  useEffect(() => {
    if (isPlayerReady && playerRef.current && src) {
      updatePlayerSource();
    }
  }, [src, isPlayerReady]);

  const updatePlayerSource = () => {
    if (!playerRef.current || !src) return;

    try {
      console.log('🎥 Atualizando fonte Video.js streaming:', src);
      
      // Detectar tipo de fonte
      const isHLS = src.includes('.m3u8') || isLive;
      
      const sourceConfig = {
        src: src,
        type: isHLS ? 'application/x-mpegURL' : 'video/mp4',
        withCredentials: false
      };

      // Limpar fonte atual
      if (typeof playerRef.current.pause === 'function') {
        playerRef.current.pause();
      }
      
      if (typeof playerRef.current.src === 'function') {
        playerRef.current.src('');
      }
      
      // Aguardar e definir nova fonte
      setTimeout(() => {
        if (playerRef.current && typeof playerRef.current.src === 'function') {
          playerRef.current.src(sourceConfig);
          
          if (autoplay) {
            setTimeout(() => {
              if (playerRef.current && typeof playerRef.current.play === 'function') {
                playerRef.current.play().catch((error: any) => {
                  console.warn('Autoplay falhou:', error);
                });
              }
            }, 500);
          }
        }
      }, 200);
      
    } catch (error) {
      console.error('Erro ao atualizar fonte:', error);
      setError('Erro ao carregar stream');
    }
  };

  const retry = () => {
    setError(null);
    setLoading(true);
    setRetryCount(0);
    
    if (playerRef.current && src) {
      updatePlayerSource();
    } else {
      cleanupPlayer();
      setTimeout(() => {
        if (videoRef.current && window.videojs) {
          // Reinicializar player
          const event = new Event('retry');
          videoRef.current.dispatchEvent(event);
        }
      }, 1000);
    }
  };

  const openInNewTab = () => {
    if (src) {
      window.open(src, '_blank');
    }
  };

  const getConnectionIcon = () => {
    switch (connectionStatus) {
      case 'connected':
        return <Wifi className="h-4 w-4 text-green-500" />;
      case 'connecting':
        return <Activity className="h-4 w-4 text-yellow-500 animate-pulse" />;
      case 'disconnected':
        return <WifiOff className="h-4 w-4 text-red-500" />;
    }
  };

  if (!src) {
    return (
      <div className={`aspect-video bg-gradient-to-br from-gray-800 to-gray-900 rounded-lg flex flex-col items-center justify-center text-white ${className}`}>
        <Play className="h-16 w-16 mb-4 text-gray-400" />
        <h3 className="text-xl font-semibold mb-2">Video.js Streaming Player</h3>
        <p className="text-gray-400 text-center max-w-md">
          Player profissional com suporte completo a HLS/M3U8 para transmissões ao vivo
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`videojs-streaming-player relative ${className}`}>
      {/* Indicador de transmissão ao vivo */}
      {isLive && (
        <div className="absolute top-4 left-4 z-20">
          <div className="bg-red-600 text-white px-3 py-1 rounded-full flex items-center space-x-2 text-sm font-medium">
            <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
            <span>AO VIVO</span>
          </div>
        </div>
      )}

      {/* Status da conexão */}
      <div className="absolute top-4 right-4 z-20">
        <div className="bg-black bg-opacity-60 text-white px-2 py-1 rounded-full flex items-center space-x-1">
          {getConnectionIcon()}
          <span className="text-xs">{connectionStatus}</span>
        </div>
      </div>

      {/* Marca d'água */}
      {watermark && (
        <div
          className={`absolute z-10 pointer-events-none ${
            watermark.position === 'top-left' ? 'top-4 left-4' :
            watermark.position === 'top-right' ? 'top-4 right-4' :
            watermark.position === 'bottom-left' ? 'bottom-20 left-4' :
            'bottom-20 right-4'
          }`}
          style={{ opacity: watermark.opacity / 100 }}
        >
          <img
            src={watermark.url}
            alt="Watermark"
            className="max-w-24 max-h-12 object-contain"
          />
        </div>
      )}

      {/* Estatísticas do stream */}
      {streamStats && showStats && (
        <div className="absolute bottom-20 left-4 z-20 bg-black bg-opacity-80 text-white p-3 rounded-lg text-sm">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <Eye className="h-3 w-3" />
              <span>{streamStats.viewers || 0} espectadores</span>
            </div>
            <div className="flex items-center space-x-2">
              <Activity className="h-3 w-3" />
              <span>{streamStats.bitrate || 0} kbps</span>
            </div>
            <div className="flex items-center space-x-2">
              <Clock className="h-3 w-3" />
              <span>{streamStats.uptime || '00:00:00'}</span>
            </div>
            {streamStats.quality && (
              <div className="flex items-center space-x-2">
                <Settings className="h-3 w-3" />
                <span>{streamStats.quality}</span>
              </div>
            )}
            {streamStats.isRecording && (
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                <span>Gravando</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Botão de estatísticas */}
      {streamStats && (
        <div className="absolute top-4 right-16 z-20">
          <button
            onClick={() => setShowStats(!showStats)}
            className="bg-black bg-opacity-60 text-white p-2 rounded-full hover:bg-opacity-80 transition-opacity"
            title="Estatísticas"
          >
            <Activity className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-30 bg-black bg-opacity-50 rounded-lg">
          <div className="flex flex-col items-center space-y-2">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            <span className="text-white text-sm">
              {connectionStatus === 'connecting' ? 'Conectando ao stream...' : 'Carregando player...'}
            </span>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-30 bg-black bg-opacity-75 rounded-lg">
          <div className="flex flex-col items-center space-y-4 text-white text-center max-w-md">
            <AlertCircle className="h-12 w-12 text-red-500" />
            <div>
              <h3 className="text-lg font-semibold mb-2">Erro no Stream</h3>
              <p className="text-sm text-gray-300 mb-4">{error}</p>
              <div className="flex space-x-3">
                <button
                  onClick={retry}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors flex items-center space-x-2"
                >
                  <RotateCcw className="h-4 w-4" />
                  <span>Tentar Novamente</span>
                </button>
                {src && (
                  <button
                    onClick={openInNewTab}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center space-x-2"
                  >
                    <ExternalLink className="h-4 w-4" />
                    <span>Abrir Direto</span>
                  </button>
                )}
              </div>
              {retryCount > 0 && (
                <p className="text-xs text-gray-400 mt-2">
                  Tentativas: {retryCount}/{maxRetries}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Elemento de vídeo para Video.js */}
      <video
        ref={videoRef}
        className="video-js vjs-default-skin w-full aspect-video"
        controls={controls}
        preload="auto"
        data-setup="{}"
        playsInline
        crossOrigin="anonymous"
      />

      {/* Título do stream */}
      {title && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pointer-events-none rounded-b-lg">
          <h3 className="text-white text-lg font-semibold truncate">{title}</h3>
          {streamStats && (
            <div className="text-white text-sm opacity-80 mt-1">
              {streamStats.quality && <span>{streamStats.quality}</span>}
              {streamStats.bitrate && <span> • {streamStats.bitrate} kbps</span>}
              {isLive && <span> • AO VIVO</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default VideoJSStreamingPlayer;