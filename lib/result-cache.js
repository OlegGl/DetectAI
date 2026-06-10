/**
 * result-cache.js
 * Content-hash cache of detection verdicts in chrome.storage.local.
 *
 * The fastest model call is the one you don't make. Re-visits, manual re-scans,
 * SPA re-walks, and repeated boilerplate (cookie banners, footers, syndicated
 * text) all hit the cache and resolve in sub-millisecond storage reads instead
 * of multi-second local generation.
 *
 * Key = `${promptVersion}|${model}|${hash(normalizedText)}` so a prompt change
 * or model switch cleanly invalidates entries.
 */

const CACHE_KEY = 'detectai_result_cache';
const MAX_ENTRIES = 4000; // ~300 bytes each → ~1.2 MB, well under quota

let mem = null;          // in-memory map { key: { label, confidence, signals, reasoning, t } }
let dirty = false;
let saveTimer = null;

// cyrb53 — fast, non-cryptographic 53-bit hash (collision resistance not needed).
function hashText(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function normText(t) {
  return (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function keyFor(text, model, promptVersion) {
  return `${promptVersion}|${model}|${hashText(normText(text))}`;
}

async function ensureLoaded() {
  if (mem) return;
  try {
    const o = await chrome.storage.local.get(CACHE_KEY);
    mem = o[CACHE_KEY] || {};
  } catch {
    mem = {};
  }
}

// A verdict is worth caching only if it's a real model result — not a parse
// fallback and not an "insufficient" placeholder.
function isCacheable(result) {
  if (!result || result.label === 'insufficient') return false;
  if (
    result.label === 'ambiguous' &&
    /parse|missing|no result|did not contain|could not/i.test(result.reasoning || '')
  ) {
    return false;
  }
  // Reject the coerced-default signature (exactly 0.5, no reasoning, no
  // signals) — that's what a malformed model line normalizes to, not a real
  // verdict. Caching it would pin a glitch forever.
  if (
    result.label === 'ambiguous' &&
    result.confidence === 0.5 &&
    !result.reasoning &&
    (!result.signals || result.signals.length === 0)
  ) {
    return false;
  }
  return true;
}

export async function getCached(text, model, promptVersion) {
  await ensureLoaded();
  const e = mem[keyFor(text, model, promptVersion)];
  if (!e) return null;
  // LRU touch in memory only — do NOT mark dirty here. Persisting on every read
  // turned each cache-hit page into a full ~1MB rewrite; timestamps get saved
  // alongside the next real write instead.
  e.t = Date.now();
  return { label: e.label, confidence: e.confidence, signals: e.signals || [], reasoning: e.reasoning || '' };
}

export async function putCached(text, model, promptVersion, result) {
  if (!isCacheable(result)) return;
  await ensureLoaded();
  mem[keyFor(text, model, promptVersion)] = {
    label: result.label,
    confidence: result.confidence,
    signals: result.signals || [],
    reasoning: result.reasoning || '',
    t: Date.now(),
  };
  dirty = true;
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 1500);
}

async function flush() {
  saveTimer = null;
  if (!dirty || !mem) return;
  dirty = false;
  const keys = Object.keys(mem);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => mem[a].t - mem[b].t); // oldest first
    const drop = keys.length - MAX_ENTRIES;
    for (let i = 0; i < drop; i++) delete mem[keys[i]];
  }
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: mem });
  } catch {
    /* quota or unavailable — non-fatal */
  }
}

export async function clearCache() {
  mem = {};
  dirty = false;
  try { await chrome.storage.local.remove(CACHE_KEY); } catch {}
}
