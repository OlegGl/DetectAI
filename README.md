# DetectAI — AI Text Detector (Chrome Extension)

A Chrome MV3 extension that scans web page text and highlights AI‑generated content with a thin red outline, right in your browser — privately. Detection runs against a **local Ollama model** (default) or the **Anthropic Claude API**; your text is never sent to any DetectAI server.

## Features

- **Per‑paragraph detection** — flags AI text inside otherwise‑human pages at the block level, using a forensic‑linguistics (VERMILLION) prompt: uniform sentence length, formulaic transitions, over‑hedging, nominalization, lack of personal voice, etc.
- **Progressive / lazy scanning** — visible text first, then more as you scroll (IntersectionObserver), plus live re‑scans on dynamic content (MutationObserver) and on clicks/keypresses that reveal hidden sections.
- **Streaming results** — with Ollama, verdicts stream in segment‑by‑segment (JSONL) so outlines appear in well under a second instead of after the whole batch.
- **Fast local default** — `qwen2.5:3b` (small, non‑reasoning, great JSON) — ~40× faster to first result than a 31B reasoning model.
- **Content‑hash cache** — re‑visits, re‑scans, and repeated boilerplate resolve instantly from `chrome.storage`.
- **Hover tooltips** — confidence %, detected signals, and reasoning on each flagged paragraph.
- **Floating status badge** (bottom‑left) — scanning / done / error, with a hover info panel and a click‑to‑open **debug log** (when Debug mode is enabled).

## Install (unpacked)

1. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select this folder.
2. First run opens an onboarding flow to pick a backend.

## Backends

### Ollama (default, local, free)

```bash
# Install Ollama (https://ollama.com), then:
ollama pull qwen2.5:3b
```

Ollama must allow the extension's origin (it otherwise returns `403`). On macOS the included `setup-ollama.sh` configures this; or manually:

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
launchctl setenv OLLAMA_FLASH_ATTENTION "1"   # faster prefill on Apple Silicon
# then restart Ollama
```

For a larger/more accurate model: `ollama pull qwen2.5:7b` (or `gemma2:9b`) and set its exact `name:tag` in **Options**. Bare names auto‑resolve to the installed tag.

### Anthropic Claude API

Enter an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys) in **Options**. The key is stored locally in `chrome.storage` and never leaves your browser except to call the Anthropic API.

## Architecture

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker — settings, all LLM calls, tab state, Ollama CORS rule, model migration |
| `content.js` | Page scanning, lazy/scroll queue, overlays, tooltips, status badge, debug log |
| `lib/api-client.js` | Anthropic + Ollama (streaming) clients, model resolution, preload |
| `lib/detection-prompts.js` | VERMILLION prompts (full / compact / streaming JSONL), response parsing |
| `lib/result-cache.js` | Content‑hash verdict cache |
| `lib/text-chunker.js`, `lib/detection-store.js` | Chunking, per‑tab state |
| `popup.* / options.* / onboarding/*` | UI surfaces |

## Privacy

All analysis happens locally (Ollama) or via your own API key (Anthropic). No telemetry, no third‑party servers.

## License

MIT
