import { WebSocketServer } from 'ws';

/**
 * Companion hub for the local voice assistant. A phone or second screen opens
 * remote.html, which connects here rather than to /api/voice/ws. The hub
 * mirrors every text frame of the live voice session to the remotes and
 * forwards their typed commands, interrupts and WAV utterances to that
 * session. Spoken replies stay on the globe machine: remotes only see text.
 *
 * Frames to remotes:
 *   {type:'sessions', active:[sessionId]}        on connect, open and close
 *   {type:'session', sessionId, frame}           every voice frame but audio_chunk
 *   {type:'ack', command, sessionId}             a command was forwarded
 *   {type:'error', error}                        a command could not be forwarded
 * Frames from remotes:
 *   {type:'text', text} | {type:'interrupt'} | binary WAV + {type:'audio_end'}
 */
export const REMOTE_WS_PATH = '/api/voice/remote';
export const NO_SESSION_ERROR =
  'No voice session is active on the globe; tap MIC there first';
export const NO_REMOTE_AUDIO_ERROR =
  'The active voice session does not accept remote audio';
export const MAX_REMOTE_UTTERANCE_BYTES = 2 * 1024 * 1024;
const OPEN = 1;

export function createRemoteHub({ log = () => {} } = {}) {
  /** sessionId -> { sendText, interrupt, sendUtterance }; insertion order is recency. */
  const sessions = new Map();
  /** remote socket -> { audio } */
  const remotes = new Map();

  const activeIds = () => [...sessions.keys()];
  const sessionsFrame = () => ({ type: 'sessions', active: activeIds() });

  function sendTo(remote, frame) {
    if ((remote.readyState ?? OPEN) !== (remote.OPEN ?? OPEN)) return false;
    try {
      remote.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  function broadcast(frame) {
    const text = JSON.stringify(frame);
    let delivered = 0;
    for (const remote of remotes.keys()) if (sendTo(remote, text)) delivered++;
    return delivered;
  }

  function active() {
    const id = activeIds().at(-1);
    return id === undefined ? null : { id, handlers: sessions.get(id) || {} };
  }

  function handleCommand(remote, event) {
    const state = remotes.get(remote);
    if (!state || !event || typeof event.type !== 'string') return;
    const target = active();
    const reject = (error) => sendTo(remote, { type: 'error', error });
    if (event.type === 'text') {
      const text = String(event.text || '')
        .trim()
        .slice(0, 4000);
      if (!text) return;
      if (!target) return reject(NO_SESSION_ERROR);
      log('remote.text', { sessionId: target.id, text });
      // Text turns produce no transcript frame, so mirror the command to every
      // remote the same way a spoken utterance would appear.
      broadcast({
        type: 'session',
        sessionId: target.id,
        frame: { type: 'transcript', text, source: 'remote' },
      });
      target.handlers.sendText?.(text);
      sendTo(remote, { type: 'ack', command: 'text', sessionId: target.id });
      return;
    }
    if (event.type === 'interrupt') {
      if (!target) return reject(NO_SESSION_ERROR);
      target.handlers.interrupt?.();
      sendTo(remote, {
        type: 'ack',
        command: 'interrupt',
        sessionId: target.id,
      });
      return;
    }
    if (event.type === 'audio_end') {
      const bytes = state.audio;
      state.audio = Buffer.alloc(0);
      if (!bytes.length) return;
      if (!target) return reject(NO_SESSION_ERROR);
      if (typeof target.handlers.sendUtterance !== 'function')
        return reject(NO_REMOTE_AUDIO_ERROR);
      log('remote.utterance', { sessionId: target.id, bytes: bytes.length });
      target.handlers.sendUtterance(bytes);
      sendTo(remote, {
        type: 'ack',
        command: 'audio_end',
        sessionId: target.id,
        bytes: bytes.length,
      });
    }
    // Unknown frames are accepted and ignored, as on the voice socket.
  }

  function handleMessage(remote, raw, isBinary) {
    const state = remotes.get(remote);
    if (!state) return;
    if (isBinary) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (state.audio.length + chunk.length > MAX_REMOTE_UTTERANCE_BYTES) {
        state.audio = Buffer.alloc(0);
        sendTo(remote, { type: 'error', error: 'Utterance too long' });
        return;
      }
      state.audio = Buffer.concat([state.audio, chunk]);
      return;
    }
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      sendTo(remote, { type: 'error', error: 'Invalid JSON' });
      return;
    }
    handleCommand(remote, event);
  }

  const hub = {
    /** A voice session announces itself; the newest registration is the target. */
    registerSession(sessionId, handlers = {}) {
      sessions.delete(sessionId);
      sessions.set(sessionId, handlers);
      log('remote.session.register', { sessionId, active: activeIds() });
      broadcast(sessionsFrame());
    },
    unregisterSession(sessionId) {
      if (!sessions.delete(sessionId)) return false;
      log('remote.session.unregister', { sessionId, active: activeIds() });
      broadcast(sessionsFrame());
      return true;
    },
    /** Mirror one outbound voice frame; audio_chunk never leaves the globe. */
    publish(sessionId, frame) {
      if (!frame || typeof frame.type !== 'string') return 0;
      if (frame.type === 'audio_chunk' || !remotes.size) return 0;
      return broadcast({ type: 'session', sessionId, frame });
    },
    /** Adopt one connected remote socket (ws or any EventEmitter-like fake). */
    attachRemote(remote) {
      remotes.set(remote, { audio: Buffer.alloc(0) });
      remote.on?.('message', (raw, isBinary) =>
        handleMessage(remote, raw, isBinary),
      );
      remote.on?.('close', () => hub.detachRemote(remote));
      remote.on?.('error', () => hub.detachRemote(remote));
      log('remote.open', { remotes: remotes.size });
      sendTo(remote, sessionsFrame());
      return () => hub.detachRemote(remote);
    },
    detachRemote(remote) {
      return remotes.delete(remote);
    },
    handleMessage,
    /**
     * Accept companion WebSockets on the dev/preview HTTP server. Uses its own
     * upgrade marker so the voice socket's listener (voice.js) stays attached.
     */
    attachRemoteWebSocket(
      server,
      path = process.env.VOICE_REMOTE_WS_PATH || REMOTE_WS_PATH,
      { WebSocketServerImpl = WebSocketServer } = {},
    ) {
      const httpServer = server?.httpServer;
      if (!httpServer) return null;
      const marker = '__gevRemoteUpgrade';
      if (httpServer[marker]) httpServer.off('upgrade', httpServer[marker]);
      const wss = new WebSocketServerImpl({
        noServer: true,
        maxPayload: MAX_REMOTE_UTTERANCE_BYTES,
      });
      const onUpgrade = (request, socket, head) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname !== path) return;
        wss.handleUpgrade(request, socket, head, (ws) =>
          wss.emit('connection', ws, request),
        );
      };
      httpServer[marker] = onUpgrade;
      httpServer.on('upgrade', onUpgrade);
      wss.on('connection', (ws) => hub.attachRemote(ws));
      return wss;
    },
    get activeSessionId() {
      return active()?.id ?? null;
    },
    get sessionIds() {
      return activeIds();
    },
    get remoteCount() {
      return remotes.size;
    },
  };
  return hub;
}

/** One hub per server process, shared by the voice socket and the plugin. */
export function sharedRemoteHub(options) {
  const key = '__gevRemoteHub';
  if (!globalThis[key]) globalThis[key] = createRemoteHub(options);
  return globalThis[key];
}

/** Attach the shared hub's companion socket to a Vite dev or preview server. */
export function installRemoteHub(server, path) {
  const hub = sharedRemoteHub();
  hub.attachRemoteWebSocket(server, path);
  return hub;
}
