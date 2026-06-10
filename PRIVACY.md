# DetectAI — Privacy Policy

**Effective date: June 10, 2026**

DetectAI is a Chrome extension that analyzes the text of web pages you visit and visually highlights paragraphs that are likely AI-generated. It is designed to be private by default.

## The short version

- **We operate no servers and receive no data.** Nothing you browse, type, or configure is ever sent to the developer of DetectAI.
- **Analysis happens with an AI backend that you configure and control** — either a local Ollama model running on your own computer (default), or your own Anthropic API key.
- **No analytics, no tracking, no ads, no accounts.**

## What data the extension processes

**Page text.** To perform detection, the extension reads the visible text of web pages you visit and sends it, in batches of paragraphs, to the AI backend you configured:

- **Ollama (default):** text is sent to your own Ollama server (typically `http://localhost:11434` on your own machine). It never leaves your computer.
- **Anthropic API (optional):** if you choose this backend and supply your own API key, paragraph text is sent directly from your browser to Anthropic (`api.anthropic.com`) for analysis under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy). DetectAI adds no intermediary — the developer never sees this traffic.

**Settings and API key.** Your settings (backend choice, model name, sensitivity threshold, toggles) and, if provided, your Anthropic API key are stored locally in your browser using `chrome.storage.local`. The API key is used solely to authenticate your own requests to Anthropic and is never transmitted anywhere else.

**Detection cache.** To avoid re-analyzing identical text, the extension stores a local cache of detection verdicts (a content hash plus the verdict — not the page text itself) in `chrome.storage.local`. This cache never leaves your browser. It is cleared when you uninstall the extension.

**Per-tab scan status** is kept in `chrome.storage.session` and is erased when the browser closes.

## What we do NOT do

- We do not collect, transmit, sell, or share any user data with the developer or any third party (other than the AI backend **you** configured, as described above).
- We do not use analytics, telemetry, fingerprinting, or advertising of any kind.
- We do not log your browsing history. URLs are not sent to any backend; only paragraph text from the pages you scan is sent for analysis.
- We do not use your data for creditworthiness, lending, or any purpose unrelated to AI-text detection.

## Permissions explained

- **Access to websites (`<all_urls>`):** required to read page text and draw highlight outlines on any site you visit. Scanning can be disabled per the master toggle, or set to manual-only.
- **storage / unlimitedStorage:** saves your settings and the local verdict cache.
- **alarms:** keeps the background worker alive during a long page scan.
- **tabs:** routes scan results and settings updates to the correct tab and shows per-tab status in the popup.
- **declarativeNetRequestWithHostAccess:** removes the `Origin` header only on requests to the Ollama host you configured (e.g. `localhost:11434`), which Ollama otherwise rejects. It is not applied to any other traffic.

## Accuracy disclaimer

AI-text detection is probabilistic and imperfect. Verdicts are calibrated likelihoods, not proof of authorship. Polished human writing can resemble AI output and edited AI output can resemble human writing. **Do not use DetectAI's results as the sole basis for accusations, grading, employment, or any consequential decision about a person.**

## Changes

If this policy changes, the updated version will be posted at this URL with a new effective date.

## Contact

Questions: **bitaria@gmail.com**
