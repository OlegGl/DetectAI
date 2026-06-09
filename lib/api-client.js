/**
 * api-client.js
 * ES6 module — all LLM API calls for DetectAI.
 * Handles Anthropic (with prompt caching) and Ollama (local).
 */

import { buildSystemPrompt, buildUserPrompt, parseDetectionResponse, parseStreamingLine, PROMPT_VERSION } from './detection-prompts.js';
import { buildInsufficientResults } from './text-chunker.js';
import { getCached, putCached } from './result-cache.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Identifier used in cache keys so a model/prompt change invalidates entries.
async function cacheModelId(settings) {
  if (settings.apiBackend === 'ollama') {
    const url = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
    return 'ollama:' + (await resolveOllamaModel(url, settings.ollamaModel || 'qwen2.5:7b'));
  }
  return 'anthropic:claude-sonnet-4-6';
}

/**
 * Detect AI-generated text across a batch of paragraphs.
 *
 * Pipeline: short paragraphs → "insufficient" (no call). Remaining → cache
 * lookup; cache hits are emitted immediately. Cache misses are chunked and sent
 * to the backend. The Ollama path streams per-segment verdicts as they arrive.
 *
 * @param {Array<{id, text}>} paragraphs
 * @param {Settings} settings
 * @param {{ onDebug?: Function, onPartial?: Function }} [hooks]
 * @returns {Promise<Array<DetectionResult>>}
 */
export async function detectTextBatch(paragraphs, settings, hooks = {}) {
  if (!paragraphs || paragraphs.length === 0) return [];
  const dbg = typeof hooks.onDebug === 'function' ? hooks.onDebug : () => {};
  // onPartial(results[]) paints outlines as soon as each verdict is known.
  const emit = typeof hooks.onPartial === 'function' ? hooks.onPartial : () => {};

  const modelId = await cacheModelId(settings);

  // Insufficient (too short) — resolved without any call or cache.
  const insufficients = paragraphs.filter((p) => !p || typeof p.text !== 'string' || p.text.trim().length < 80);
  const eligible = paragraphs.filter((p) => p && typeof p.text === 'string' && p.text.trim().length >= 80);
  const insufficientResults = buildInsufficientResults(insufficients);

  // Cache lookup — hits paint instantly.
  const misses = [];
  const cachedResults = [];
  for (const p of eligible) {
    const hit = await getCached(p.text, modelId, PROMPT_VERSION);
    if (hit) {
      cachedResults.push({ id: p.id, ...hit });
    } else {
      misses.push(p);
    }
  }
  if (cachedResults.length > 0) {
    emit(cachedResults);
    dbg({ phase: 'cache', hits: cachedResults.length, misses: misses.length });
  }

  // Chunk only the misses.
  const chunkSize = settings.apiBackend === 'ollama' ? 12 : 10;
  const chunks = [];
  for (let i = 0; i < misses.length; i += chunkSize) chunks.push(misses.slice(i, i + chunkSize));

  dbg({ phase: 'chunked', total: paragraphs.length, eligible: eligible.length,
        cached: cachedResults.length, chunks: chunks.length, chunkSize,
        insufficient: insufficients.length, backend: settings.apiBackend });

  const freshResults = [];
  for (const chunk of chunks) {
    let results;
    if (settings.apiBackend === 'ollama') {
      results = await callOllamaAPI(chunk, settings, dbg, emit);
    } else {
      results = await callAnthropicAPI(chunk, settings, dbg);
      emit(results); // Anthropic is non-streaming — paint the whole chunk at once.
    }
    freshResults.push(...results);
    // Persist fresh verdicts for next time.
    for (const r of results) {
      const src = chunk.find((p) => p.id === r.id);
      if (src) putCached(src.text, modelId, PROMPT_VERSION, r);
    }
  }

  // Merge everything and restore original paragraph order.
  const resultMap = new Map(
    [...insufficientResults, ...cachedResults, ...freshResults].map((r) => [r.id, r])
  );
  return paragraphs.map(({ id }) =>
    resultMap.get(id) || {
      id, label: 'ambiguous', confidence: 0.5,
      reasoning: 'No result returned for this segment.', signals: [],
    }
  );
}

/**
 * Test connectivity to the configured backend.
 *
 * @param {Settings} settings
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function testConnection(settings) {
  if (settings.apiBackend === 'ollama') {
    return testOllamaConnection(settings);
  }
  return testAnthropicConnection(settings);
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic Messages API for a single chunk of paragraphs.
 *
 * @param {Array<{id: string, text: string}>} paragraphsChunk
 * @param {Settings} settings
 * @returns {Promise<Array<DetectionResult>>}
 */
async function callAnthropicAPI(paragraphsChunk, settings, onDebug) {
  const dbg = typeof onDebug === 'function' ? onDebug : () => {};
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(paragraphsChunk);
  const startedAt = Date.now();
  dbg({ phase: 'request', backend: 'anthropic', model: 'claude-sonnet-4-6',
        segmentIds: paragraphsChunk.map((p) => p.id),
        sample: paragraphsChunk.map((p) => ({ id: p.id, text: (p.text || '').slice(0, 140) })) });

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const headers = {
    'x-api-key': settings.anthropicApiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    // Required for browser/extension-originated requests, otherwise the API
    // rejects them with a CORS error. (Prompt caching is GA — no beta header.)
    'anthropic-dangerous-direct-browser-access': 'true',
  };

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body,
    });
  } catch (networkError) {
    throw new Error(
      `Network error contacting Anthropic API: ${networkError.message}`
    );
  }

  // Handle 529 overload with a single retry
  if (response.status === 529) {
    await sleep(2000);
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body,
      });
    } catch (retryError) {
      throw new Error(
        `Anthropic API unavailable after retry: ${retryError.message}`
      );
    }
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errBody = await response.json();
      errorDetail = errBody?.error?.message || JSON.stringify(errBody);
    } catch {
      errorDetail = await response.text().catch(() => '');
    }
    throw new Error(
      `Anthropic API error ${response.status}: ${errorDetail || response.statusText}`
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error(`Failed to parse Anthropic API JSON response: ${e.message}`);
  }

  const text = data?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(
      'Unexpected Anthropic API response shape: missing content[0].text'
    );
  }

  const parsed = parseDetectionResponse(text, paragraphsChunk);
  dbg({ phase: 'response', backend: 'anthropic', model: 'claude-sonnet-4-6',
        ms: Date.now() - startedAt, rawSnippet: text.slice(0, 600),
        verdicts: parsed.map((r) => ({ id: r.id, label: r.label, confidence: r.confidence })) });
  return parsed;
}

/**
 * Test that the Anthropic API key is valid by sending a minimal detection request.
 *
 * @param {Settings} settings
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function testAnthropicConnection(settings) {
  if (!settings.anthropicApiKey || settings.anthropicApiKey.trim() === '') {
    return { ok: false, message: 'No Anthropic API key configured.' };
  }

  // Minimal auth/connectivity check — no system prompt, max_tokens:1. Avoids
  // the full ~1200-token detection call (seconds of latency + token spend).
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': settings.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    if (response.ok) {
      return { ok: true, message: 'Connected to Claude API successfully.' };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'Invalid API key (authentication failed).' };
    }

    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || '';
    } catch { /* ignore */ }
    return { ok: false, message: `Anthropic API error ${response.status}${detail ? ': ' + detail : ''}` };
  } catch (err) {
    return { ok: false, message: `Network error contacting Anthropic API: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

// Cache of configured-name → actual installed tag, to avoid re-querying /api/tags.
const ollamaModelResolutionCache = new Map();

/**
 * List installed Ollama model names (e.g. ["gemma4:31b-mlx", "llama3.1:8b"]).
 */
async function listOllamaModels(ollamaUrl) {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => m.name).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve the configured model name to an actually-installed tag.
 * Handles the common case where the user has `gemma4:31b-mlx` installed but
 * the setting is just `gemma4` (Ollama does NOT auto-resolve bare names).
 */
async function resolveOllamaModel(ollamaUrl, configured) {
  if (!configured) return configured;
  if (ollamaModelResolutionCache.has(configured)) {
    return ollamaModelResolutionCache.get(configured);
  }

  const installed = await listOllamaModels(ollamaUrl);
  let resolved = configured;

  if (installed.length > 0 && !installed.includes(configured)) {
    // Exact ":latest" form, else first tag sharing the same base name.
    const base = configured.split(':')[0];
    resolved =
      installed.find((n) => n === `${configured}:latest`) ||
      installed.find((n) => n.split(':')[0] === base) ||
      configured;
  }

  ollamaModelResolutionCache.set(configured, resolved);
  return resolved;
}

// Shared Ollama generation options. num_ctx is kept CONSTANT across requests so
// Ollama reuses the KV cache for the shared system-prompt prefix; keep_alive:-1
// keeps the model + cache warm (preload eliminates the cold-start wait).
const OLLAMA_OPTIONS = { temperature: 0, top_p: 0.9, num_predict: 2048, num_ctx: 8192 };

/**
 * Preload (warm) the Ollama model so the first real batch isn't blocked on the
 * multi-second cold load. Fire-and-forget; errors are ignored.
 */
export async function preloadOllama(settings) {
  try {
    const ollamaUrl = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
    const model = await resolveOllamaModel(ollamaUrl, settings.ollamaModel || 'qwen2.5:7b');
    // Empty messages + keep_alive:-1 loads the model into memory and pins it.
    await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [], keep_alive: -1 }),
    });
  } catch { /* best effort */ }
}

/**
 * Call the local Ollama /api/chat endpoint for a single chunk of paragraphs,
 * STREAMING the response and emitting each segment verdict as its JSONL line
 * completes (onPartial), so outlines appear mid-chunk instead of all at once.
 *
 * @param {Array<{id, text}>} paragraphsChunk
 * @param {Settings} settings
 * @param {Function} [onDebug]
 * @param {Function} [onPartial] called with [result] as each verdict streams in
 * @returns {Promise<Array<DetectionResult>>}
 */
async function callOllamaAPI(paragraphsChunk, settings, onDebug, onPartial) {
  const dbg = typeof onDebug === 'function' ? onDebug : () => {};
  const emit = typeof onPartial === 'function' ? onPartial : () => {};

  // Streaming JSONL prompt (one object per line, no reasoning) — must NOT use
  // format:"json" (grammar mode buffers the whole response, defeating streaming).
  const systemPrompt = buildSystemPrompt('ollama-stream');
  const userPrompt = buildUserPrompt(paragraphsChunk);

  const ollamaUrl = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const model = await resolveOllamaModel(ollamaUrl, settings.ollamaModel || 'qwen2.5:7b');

  const ids = paragraphsChunk.map((p) => p.id);
  const idSet = new Set(ids);

  dbg({ phase: 'request', backend: 'ollama', model, url: `${ollamaUrl}/api/chat`, streaming: true,
        segmentIds: ids, promptChars: systemPrompt.length + userPrompt.length,
        sample: paragraphsChunk.map((p) => ({ id: p.id, text: (p.text || '').slice(0, 140) })) });

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: true,
    keep_alive: -1,
    options: OLLAMA_OPTIONS,
  });

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch (networkError) {
    dbg({ phase: 'error', backend: 'ollama', model, ms: Date.now() - startedAt, error: 'Ollama not running / unreachable' });
    throw new Error('Ollama not running. Start Ollama and try again.');
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        'Ollama blocked the request (403). Ollama must allow the extension origin. ' +
        'Quit Ollama, then run in Terminal:  OLLAMA_ORIGINS="*" ollama serve  ' +
        '(or set it permanently with: launchctl setenv OLLAMA_ORIGINS "chrome-extension://*" and restart Ollama).'
      );
    }
    let errorDetail = '';
    try {
      const errBody = await response.json();
      errorDetail = errBody?.error || JSON.stringify(errBody);
    } catch {
      errorDetail = await response.text().catch(() => '');
    }
    if (response.status === 404 || /not found|no such model/i.test(errorDetail)) {
      const installed = await listOllamaModels(ollamaUrl);
      const list = installed.length ? installed.join(', ') : '(none installed — run: ollama pull <model>)';
      throw new Error(
        `Ollama model "${model}" not found. Installed models: ${list}. Set the exact name in DetectAI Options.`
      );
    }
    throw new Error(`Ollama API error ${response.status}: ${errorDetail || response.statusText}`);
  }

  // ── Stream: Ollama emits newline-delimited envelopes; each carries a content
  //    delta. We concatenate deltas into modelContent, then parse the model's
  //    own JSONL lines as they complete. ──────────────────────────────────────
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let envBuf = '';
  let modelContent = '';
  let processedLines = 0;
  const collected = new Map();
  let evalCount, promptEvalCount, streamErr;

  const flushModelLines = (isFinal) => {
    const parts = modelContent.split('\n');
    const completeCount = isFinal ? parts.length : parts.length - 1;
    for (let i = processedLines; i < completeCount; i++) {
      const r = parseStreamingLine(parts[i]);
      if (r && idSet.has(r.id) && !collected.has(r.id)) {
        collected.set(r.id, r);
        emit([r]); // paint this outline immediately
      }
    }
    if (completeCount > processedLines) processedLines = completeCount;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    envBuf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = envBuf.indexOf('\n')) >= 0) {
      const envLine = envBuf.slice(0, nl);
      envBuf = envBuf.slice(nl + 1);
      if (!envLine.trim()) continue;
      let env;
      try { env = JSON.parse(envLine); } catch { continue; }
      if (env.error) { streamErr = env.error; continue; }
      if (env.message && typeof env.message.content === 'string') {
        modelContent += env.message.content;
        flushModelLines(false);
      }
      if (env.done) { evalCount = env.eval_count; promptEvalCount = env.prompt_eval_count; }
    }
  }
  flushModelLines(true);

  if (streamErr && collected.size === 0) {
    throw new Error(`Ollama API error: ${streamErr}`);
  }

  // Anything the streaming parse missed (malformed line, reordered ids) — retry
  // line-by-line over the full accumulated JSONL, then fall back to the tolerant
  // whole-response parser, so every id still gets a verdict.
  let missing = paragraphsChunk.filter((p) => !collected.has(p.id));
  if (missing.length > 0) {
    const missingSet = new Set(missing.map((p) => p.id));
    for (const line of modelContent.split('\n')) {
      const r = parseStreamingLine(line);
      if (r && missingSet.has(r.id) && !collected.has(r.id)) {
        collected.set(r.id, r);
        missingSet.delete(r.id);
        emit([r]);
      }
    }
    missing = paragraphsChunk.filter((p) => !collected.has(p.id));
  }
  if (missing.length > 0) {
    const fallback = parseDetectionResponse(modelContent, missing);
    for (const r of fallback) {
      if (!collected.has(r.id)) { collected.set(r.id, r); emit([r]); }
    }
  }

  const results = paragraphsChunk.map((p) =>
    collected.get(p.id) || { id: p.id, label: 'ambiguous', confidence: 0.5, reasoning: '', signals: [] }
  );

  dbg({ phase: 'response', backend: 'ollama', model, ms: Date.now() - startedAt,
        evalCount, promptEvalCount, streamed: true, rawSnippet: modelContent.slice(0, 600),
        verdicts: results.map((r) => ({ id: r.id, label: r.label, confidence: r.confidence })) });
  return results;
}

/**
 * Test Ollama connectivity by checking /api/tags and verifying the model exists.
 *
 * @param {Settings} settings
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function testOllamaConnection(settings) {
  const ollamaUrl = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const model = settings.ollamaModel || 'qwen2.5:7b';

  let response;
  try {
    response = await fetch(`${ollamaUrl}/api/tags`, { method: 'GET' });
  } catch {
    return {
      ok: false,
      message: `Cannot reach Ollama at ${ollamaUrl}. Make sure Ollama is running.`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `Ollama responded with status ${response.status}. Check that the URL is correct.`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, message: 'Could not parse Ollama /api/tags response.' };
  }

  // data.models is an array of { name, ... } objects
  const models = Array.isArray(data?.models) ? data.models : [];
  const modelNames = models.map((m) =>
    typeof m.name === 'string' ? m.name.split(':')[0] : ''
  );
  const requestedBase = model.split(':')[0];

  const found = modelNames.some(
    (name) => name.toLowerCase() === requestedBase.toLowerCase()
  );

  if (!found) {
    const available = models.map((m) => m.name).filter(Boolean).join(', ') || 'none';
    return {
      ok: false,
      message: `Ollama is running but model "${model}" was not found. Installed: ${available}. Run: ollama pull ${model}`,
    };
  }

  // Report the exact tag that will actually be used (e.g. gemma4 → gemma4:31b-mlx).
  const resolved = await resolveOllamaModel(ollamaUrl, model);
  return {
    ok: true,
    message: resolved === model
      ? `Connected to Ollama at ${ollamaUrl}. Model "${model}" is ready.`
      : `Connected to Ollama. Using installed model "${resolved}".`,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
