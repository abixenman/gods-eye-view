import { readRequestBody } from '../common/request.js';
import { toFiveWordHudSummary } from '../openai/hud-summary.js';

const SYSTEM_PROMPT = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'Do not infer from coordinates or invent a place.',
  'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

function ollamaBaseUrl() {
  const value = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid Ollama URL');
  return url.href.replace(/\/$/, '');
}

export async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  try {
    const context = JSON.parse((await readRequestBody(req, 64 * 1024)) || '{}');
    const response = await fetch(`${ollamaBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_HUD_MODEL || 'qwen2.5:3b',
        stream: false,
        options: { num_predict: 32 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(context) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(data?.message?.content);
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        summary: summary || null,
        error: response.ok ? null : 'Ollama HUD summary request failed',
      }),
    );
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: error?.message || 'Ollama HUD summary request failed',
      }),
    );
  }
}

export { ollamaBaseUrl };
