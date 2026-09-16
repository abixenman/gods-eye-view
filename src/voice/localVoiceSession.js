import { RealtimeInput } from './realtimeInput.js';
import {
  postDebugLog,
  sanitizeDebugValue,
  createDebugSessionId,
} from './realtimeDiagnostics.js';
import { silenceRadioForVoice } from './realtimeProtocol.js';
import { createLocalWsBackend } from './localWsBackend.js';
import { createVadCapture } from './localSpeechCapture.js';
import { createLocalPlayback } from './localAudioPlayback.js';
import {
  LOCAL_VOICE_STATUS,
  parseLocalFrame,
  localSessionEvents,
  statusForFrame,
  isTerminalErrorFrame,
} from './localVoiceProtocol.js';

/**
 * Voice-session adapter for the local Ollama pipeline. The browser owns the
 * microphone and utterance boundaries (VAD), the server owns transcription,
 * reasoning, tool calls and speech. Tool calls run through the same
 * runAction executor as the OpenAI Realtime adapter.
 */
export function createLocalVoiceSession({
  emit,
  runAction,
  runner,
  ui,
  signal,
  radioLayer = null,
  debugSink = postDebugLog,
  backend = createLocalWsBackend(),
  createCapture = createVadCapture,
  createPlayback = createLocalPlayback,
  getUserMedia = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  bargeIn = false,
}) {
  let status = 'idle';
  let socket = null;
  let stream = null;
  let capture = null;
  let playback = null;
  let epoch = 0;
  let serverInfo = null;
  let radioDucked = false;
  const sessionId = createDebugSessionId();

  const debugLog = (event, payload = {}) => {
    if (!debugSink) return;
    try {
      debugSink({
        timestamp: new Date().toISOString(),
        sessionId,
        protocol: backend.protocol,
        event,
        status,
        payload: sanitizeDebugValue(payload),
      });
    } catch {
      /* Diagnostics never affect voice. */
    }
  };

  const isActive = () => status !== 'idle' && status !== 'error';

  function setStatus(state, detail) {
    status = state;
    emit({ type: 'state', state, detail });
    if (state !== 'listening' && state !== 'executing')
      input.setVoiceSpeaker('idle');
  }

  function pauseRadioForVoice() {
    return silenceRadioForVoice({
      duckRadio: () => {
        if (radioDucked) return;
        radioDucked = true;
        radioLayer?.setVoiceDucked?.(true);
      },
      pauseRadio: () => radioLayer?.pause?.({ origin: 'voice-duck' }),
    });
  }

  const input = new RealtimeInput({
    readUi: () => ui,
    readStream: () => stream,
    readStatus: () => status,
    operations: {
      isActive,
      setStatus,
      start: (options) => start(options),
      pauseRadioForVoice,
    },
  });

  async function start() {
    if (isActive() || signal?.aborted) return;
    const myEpoch = ++epoch;
    const owns = () => myEpoch === epoch && !signal?.aborted;
    setStatus('connecting', 'Connecting local voice');
    debugLog('local.start');
    socket = backend.connect();
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('Local voice server unavailable')),
        { once: true },
      );
      socket.addEventListener(
        'close',
        () => reject(new Error('Local voice server closed the connection')),
        { once: true },
      );
    });
    socket.addEventListener('message', (event) => {
      if (owns()) void onMessage(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (!owns() || !isActive()) return;
      debugLog('local.socket.close', { code: event.code });
      teardown();
      setStatus('error', 'Local voice connection closed');
    });
    await opened;
    if (!owns()) return;
    stream = await getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    if (!owns()) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return;
    }
    input.setMicrophoneEnabled(true);
    input.startVoiceVisualizer(stream);
    input.setVoiceSpeaker('user');
    playback = createPlayback({
      onSpeaking: () => {
        if (!owns()) return;
        input.setVoiceSpeaker('ai');
        pauseRadioForVoice();
        if (!bargeIn) capture?.pause();
        if (status === 'listening' || status === 'executing')
          setStatus('executing', LOCAL_VOICE_STATUS.speaking);
      },
      onIdle: () => {
        if (!owns()) return;
        input.setVoiceSpeaker('user');
        capture?.resume();
        if (isActive()) setStatus('listening', LOCAL_VOICE_STATUS.listening);
      },
      attachVisualizer: (outputStream) =>
        input.startAssistantVoiceVisualizer(outputStream),
    });
    capture = createCapture({
      onSpeechStart: () => {
        if (!owns() || status !== 'listening') return;
        setStatus('listening', LOCAL_VOICE_STATUS.hearing);
      },
      onSpeechEnd: () => {},
      onUtterance: (bytes, meta = {}) => {
        if (!owns() || !bytes?.byteLength) return;
        debugLog('local.utterance', {
          bytes: bytes.byteLength,
          format: meta.format,
          durationMs: meta.durationMs,
        });
        backend.send(bytes);
        backend.send({ type: 'audio_end', ...meta });
        setStatus('executing', LOCAL_VOICE_STATUS.transcribing);
      },
    });
    await capture.start(stream);
    if (!owns()) return;
    setStatus('listening', LOCAL_VOICE_STATUS.listening);
    debugLog('local.listening', { capture: capture.kind });
  }

  async function onMessage(data) {
    const parsed = parseLocalFrame(data);
    if (!parsed) return;
    if (parsed.kind === 'binary') {
      void playback?.enqueueEncoded(parsed.bytes);
      return;
    }
    const { frame } = parsed;
    if (frame.type !== 'audio_chunk')
      debugLog('local.server.event', { type: frame.type, frame });
    for (const event of localSessionEvents(frame)) emit(event);
    if (frame.type === 'ready') {
      serverInfo = frame;
      return;
    }
    if (frame.type === 'audio_chunk' || frame.type === 'audio_end') {
      playback?.handle(frame);
      return;
    }
    if (frame.type === 'tool_call') {
      setStatus('executing', LOCAL_VOICE_STATUS.running);
      let result;
      try {
        result = await runAction(frame.name, frame.arguments || {}, {
          isCurrent: () => isActive(),
        });
      } catch (error) {
        result = {
          ok: false,
          error: error?.message || 'GEV command failed',
          tool: frame.name,
        };
      }
      backend.send({ type: 'tool_result', callId: frame.callId, result });
      return;
    }
    if (frame.type === 'text') {
      // Keep "executing" while speech plays; playback.onIdle returns to listening.
      if (!playback?.speaking && serverInfo?.tts !== 'piper')
        setStatus('listening', LOCAL_VOICE_STATUS.listening);
      else setStatus('executing', LOCAL_VOICE_STATUS.speaking);
      if (serverInfo?.tts === 'browser') speakWithBrowser(frame.text);
      return;
    }
    if (frame.type === 'error') {
      debugLog('local.error', { error: frame.error, terminal: frame.terminal });
      if (isTerminalErrorFrame(frame)) {
        teardown();
        setStatus('error', String(frame.error || 'Local voice unavailable'));
        return;
      }
    }
    const next = statusForFrame(frame);
    if (next && isActive()) setStatus(next.state, next.detail);
  }

  function speakWithBrowser(text) {
    const speech = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (!speech || !Utterance || !text) return;
    try {
      speech.cancel();
      speech.speak(new Utterance(String(text)));
    } catch {
      /* Browser speech is best effort. */
    }
  }

  function teardown() {
    epoch++;
    try {
      capture?.destroy();
    } catch {
      /* no-op */
    }
    capture = null;
    playback?.stop();
    playback = null;
    input.stopVoiceVisualizer();
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    backend.close(1000, 'stop');
    socket = null;
    input.resetSession();
    if (radioDucked) {
      radioDucked = false;
      radioLayer?.setVoiceDucked?.(false);
    }
    try {
      globalThis.speechSynthesis?.cancel?.();
    } catch {
      /* no-op */
    }
  }

  function stop({ removeUi = false, preserveStatus = false } = {}) {
    const wasActive = isActive();
    if (wasActive) debugLog('local.stop');
    teardown();
    status = preserveStatus && !wasActive ? status : 'idle';
    if (!preserveStatus) status = 'idle';
    if (removeUi) {
      ui?.root?.remove?.();
      emit({ type: 'disposed' });
    }
  }

  const controller = {
    runner,
    backend,
    get status() {
      return status;
    },
    get serverInfo() {
      return serverInfo;
    },
    stop,
    getDiagnostics: () => ({
      status,
      protocol: backend.protocol,
      sessionId,
      server: serverInfo,
      capture: capture?.kind || null,
    }),
  };

  return {
    controller,
    capabilities: { costControls: false, pushToTalk: false },
    start,
    stop,
    sendText(text) {
      const value = String(text || '').trim();
      if (!value || !socket) throw new Error('GEV voice is not connected');
      backend.send({ type: 'text', text: value });
      setStatus('executing', LOCAL_VOICE_STATUS.thinking);
    },
    sendMapEvent(event) {
      if (!socket) return false;
      return backend.send({ type: 'map_event', event });
    },
    ignoreButtonClick: () => false,
    bindControls() {
      input.updateVoiceButtonLabel();
      if (ui?.helpDetail)
        ui.helpDetail.textContent =
          'Local voice: speak, pause, and it answers. Tap MIC to stop.';
    },
  };
}
