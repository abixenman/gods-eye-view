import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { ollamaBaseUrl } from './hud-summary.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';
import { realtimeInstructions } from '../openai/instructions.js';

const tools = GEV_REALTIME_TOOLS.map(({ name, description, parameters }) => ({
  type: 'function',
  function: { name, description, parameters },
}));
const flyToTool = tools.find(
  (tool) => tool.function.name === 'fly_to_location',
);

// Small models are much more reliable when an unambiguous destination request
// is sent with the destination schema in scope. The model still emits the
// structured tool call and supplies/validates its arguments; this only avoids
// confusing fly_to_location with the similarly worded camera-nudge tools.
const DESTINATION_WORDS =
  /\b(?:va|vas|allez|go|fly|emm[eè]ne(?:-moi)?|montre(?:-moi)?)\b[\s\S]{0,32}\b(?:a|à|au|aux|vers|to)\b/i;

function logLocalVoice(event, payload = {}) {
  try {
    const dir = join(process.cwd(), '.gev-logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'local-voice.jsonl'),
      `${JSON.stringify({ loggedAt: new Date().toISOString(), event, ...payload })}\n`,
    );
  } catch {
    /* diagnostics must never break voice */
  }
}

function toolsForText(text) {
  const value = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (flyToTool && DESTINATION_WORDS.test(value)) {
    return [flyToTool];
  }
  return tools;
}

function chat(messages, model, scopedTools = tools) {
  const payload = {
    model,
    stream: false,
    options: {
      num_ctx: Number(process.env.OLLAMA_NUM_CTX) || 16384,
      num_predict: 256,
    },
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
    messages,
    tools: scopedTools,
  };
  if (model.startsWith('gpt-oss')) payload.think = true;
  return fetch(`${ollamaBaseUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data?.error || `Ollama chat failed (${response.status})`);
    return data;
  });
}

function attachVoiceWebSocket(
  server,
  path = process.env.VOICE_WS_PATH || '/api/voice/ws',
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  });
  server.httpServer?.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit('connection', ws, request),
    );
  });
  wss.on('connection', (ws) => {
    logLocalVoice('session.open');
    const messages = [{ role: 'system', content: realtimeInstructions() }];
    const pending = new Map();
    const worker = spawn(
      resolvePython(),
      [join(process.cwd(), 'scripts/local_audio.py')],
      { env: process.env },
    );
    logLocalVoice('worker.start');
    worker.on('exit', (code, signal) =>
      logLocalVoice('worker.exit', { code, signal }),
    );
    let audio = Buffer.alloc(0);
    let workerBuffer = '';
    const send = (payload) =>
      ws.readyState === ws.OPEN && ws.send(JSON.stringify(payload));
    send({ type: 'ready', protocol: 'ollama-local', tools: tools.length });
    worker.stdout.on('data', (chunk) => {
      workerBuffer += chunk.toString();
      const lines = workerBuffer.split('\n');
      workerBuffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'transcript') {
            logLocalVoice('transcript', { text: event.text || '' });
            send({ type: 'transcript', text: event.text || '' });
            if (event.text) processText(event.text);
          } else if (event.type === 'audio' && event.audio)
            ws.send(Buffer.from(event.audio, 'base64'));
        } catch {
          /* malformed worker output is ignored */
        }
      }
    });
    worker.on('error', (error) =>
      send({
        type: 'error',
        error: `Audio worker unavailable: ${error.message}`,
      }),
    );
    const processText = async (text) => {
      messages.push({
        role: 'user',
        content: String(text || '').slice(0, 8000),
      });
      try {
        const scopedTools = toolsForText(text);
        let response = await chat(
          messages,
          process.env.OLLAMA_VOICE_MODEL || 'qwen2.5:7b',
          scopedTools,
        );
        while (response?.message?.tool_calls?.length) {
          for (const call of response.message.tool_calls) {
            const callId = randomUUID();
            logLocalVoice('tool_call', {
              name: call.function?.name,
              arguments: call.function?.arguments || {},
            });
            send({
              type: 'tool_call',
              callId,
              name: call.function?.name,
              arguments: call.function?.arguments || {},
            });
            const result = await new Promise((resolve) =>
              pending.set(callId, resolve),
            );
            messages.push({ role: 'assistant', tool_calls: [call] });
            messages.push({
              role: 'tool',
              content: JSON.stringify(result),
              name: call.function?.name,
            });
          }
          response = await chat(
            messages,
            process.env.OLLAMA_VOICE_MODEL || 'qwen2.5:7b',
            scopedTools,
          );
        }
        const content = response?.message?.content || '';
        messages.push({ role: 'assistant', content });
        send({ type: 'text', text: content });
        worker.stdin.write(`${JSON.stringify({ tts: content })}\n`);
      } catch (error) {
        send({
          type: 'error',
          error: error?.message || 'Local voice unavailable',
        });
      }
    };
    ws.on('message', async (raw, isBinary) => {
      if (isBinary) {
        audio = Buffer.concat([audio, raw]);
        logLocalVoice('audio.chunk', {
          bytes: raw.length,
          totalBytes: audio.length,
        });
        return;
      }
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return send({ type: 'error', error: 'Invalid JSON' });
      }
      if (event.type === 'tool_result') {
        logLocalVoice('tool_result', {
          callId: event.callId,
          ok: event.result?.ok !== false,
        });
        const resolve = pending.get(event.callId);
        pending.delete(event.callId);
        resolve?.(event.result);
        return;
      }
      if (event.type === 'audio_end') {
        logLocalVoice('audio.end', { bytes: audio.length });
        if (audio.length)
          worker.stdin.write(
            `${JSON.stringify({ audio: audio.toString('base64') })}\n`,
          );
        audio = Buffer.alloc(0);
        return;
      }
      if (event.type !== 'text') return;
      processText(event.text);
    });
    ws.on('close', (code, reason) => {
      logLocalVoice('session.close', { code, reason: String(reason || '') });
      try {
        worker.kill();
      } catch {
        /* no-op */
      }
    });
  });
  return wss;
}

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  return join(
    process.cwd(),
    process.platform === 'win32'
      ? '.venv-local/Scripts/python.exe'
      : '.venv-local/bin/python',
  );
}

export { attachVoiceWebSocket, tools as OLLAMA_TOOLS };
