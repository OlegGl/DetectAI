# DetectAI — AI Text Detector (Chrome Extension)

A Chrome MV3 extension that scans web page text and highlights AI‑generated content with a thin red outline, right in your browser — privately. Detection runs against a **local Ollama model** (default) or the **Anthropic Claude API**; your text is never sent to any DetectAI server.

## Features

- **Per‑paragraph detection** — flags AI text inside otherwise‑human pages at the block level, using a forensic‑linguistics prompt (the full VERMILLION framework on Claude; a distilled, conservative variant for local models): uniform sentence length, formulaic transitions, nominalization, lack of personal voice, etc. Verdicts are calibrated P(AI) probabilities compared against a user‑set threshold (default 0.70).
- **Progressive / lazy scanning** — visible text first, then more as you scroll (IntersectionObserver), plus live re‑scans on dynamic content (MutationObserver) and on clicks/keypresses that reveal hidden sections.
- **Streaming results** — with Ollama, verdicts stream in segment‑by‑segment (JSONL) so outlines appear as they're decided instead of after the whole batch (typically ~1 s to first outline with a warm model).
- **Local default** — `qwen2.5:7b` (non‑reasoning, strong JSON output) — chosen after testing showed 3B models over‑flag formal human writing while 7B discriminates reliably, and still roughly an order of magnitude faster than large reasoning models.
- **Content‑hash cache** — re‑visits, re‑scans, and repeated boilerplate resolve instantly from `chrome.storage`.
- **Hover tooltips** — AI‑likelihood % and the detected linguistic signals on each flagged paragraph (plus the model's reasoning when using the Claude backend).
- **Floating status badge** (bottom‑left) — scanning / done / error, with a hover info panel and a click‑to‑open **debug log** (when Debug mode is enabled).

## Install (unpacked)

1. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select this folder.
2. First run opens an onboarding flow to pick a backend.

## Backends

### Ollama (default, local, free)

```bash
# Install Ollama (https://ollama.com), then:
ollama pull qwen2.5:7b
```

Ollama must allow the extension's origin (it otherwise returns `403`). On macOS the included `setup-ollama.sh` configures this; or manually:

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
launchctl setenv OLLAMA_FLASH_ATTENTION "1"   # faster prefill on Apple Silicon
# then restart Ollama
```

To trade accuracy for speed, pull a smaller model (e.g. `qwen2.5:3b` — noticeably more false positives) or a larger one (e.g. `qwen2.5:14b`) and set its `name:tag` in **Options**. Bare names auto‑resolve to the installed tag.

### Anthropic Claude API

Enter an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys) in **Options**. The key is stored locally in `chrome.storage` and never leaves your browser except to call the Anthropic API.

## Architecture

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker — settings, all LLM calls, tab state, Ollama CORS rule, model migration |
| `content.js` | Page scanning, lazy/scroll queue, overlays, tooltips, status badge, debug log |
| `lib/api-client.js` | Anthropic + Ollama (streaming) clients, model resolution, preload |
| `lib/detection-prompts.js` | Detection prompts (full VERMILLION for Claude / streaming JSONL for local models), response parsing & calibration |
| `lib/result-cache.js` | Content‑hash verdict cache |
| `lib/text-chunker.js`, `lib/detection-store.js` | Short‑segment handling, per‑tab state |
| `popup.* / options.* / onboarding/*` | UI surfaces |

## Privacy

All analysis happens locally (Ollama) or via your own API key (Anthropic). No telemetry, no third‑party servers. Full policy: [PRIVACY.md](PRIVACY.md).

## Accuracy disclaimer

AI‑text detection is probabilistic. Verdicts are calibrated likelihoods, not proof of authorship — polished human writing can resemble AI output and edited AI output can pass as human. Don't use results as the sole basis for decisions about a person's work.

## License

MIT
