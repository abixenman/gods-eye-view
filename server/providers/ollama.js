import { defaultSourceRoot } from './common/source-root.js';
import { handleHudSummary } from './ollama/hud-summary.js';
import { attachVoiceWebSocket } from './ollama/voice.js';
import { installRemoteHub } from './ollama/remote.js';
import { VAD_ASSET_ROUTE, createVadAssetHandler } from './ollama/vad-assets.js';
import { createDebugLogHandler } from './openai/debug-log.js';

/** Local voice + HUD provider used when AI_PROVIDER=ollama. */
function ollamaProxy({ sourceRoot = defaultSourceRoot } = {}) {
  function install(middlewares, server) {
    middlewares.use('/api/openai/hud-summary', handleHudSummary);
    middlewares.use('/api/ollama/hud-summary', handleHudSummary);
    middlewares.use(
      '/api/realtime/debug-log',
      createDebugLogHandler({ sourceRoot }),
    );
    middlewares.use('/api/voice/config', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          provider: process.env.AI_PROVIDER || 'openai',
          wsPath: process.env.VOICE_WS_PATH || '/api/voice/ws',
        }),
      );
    });
    middlewares.use(VAD_ASSET_ROUTE, createVadAssetHandler());
    attachVoiceWebSocket(server);
    // Phone / second-screen companion socket (remote.html); no-op without an
    // HTTP server, exactly like the voice socket above.
    installRemoteHub(server);
  }
  return {
    name: 'ollama-local-proxy',
    configureServer(server) {
      install(server.middlewares, server);
    },
    configurePreviewServer(server) {
      install(server.middlewares, server);
    },
  };
}

export { ollamaProxy };
