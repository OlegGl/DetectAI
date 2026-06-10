/**
 * detection-prompts.js
 * ES6 module — all prompt construction and response parsing logic for DetectAI.
 */

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a forensic linguist and computational text analysis expert specializing in distinguishing human-authored writing from AI-generated text. You have analyzed hundreds of thousands of text samples from both human writers and large language models (GPT-4, Claude, Gemini, Llama, Mistral, and others). Your task is to apply rigorous, signal-based linguistic analysis to classify each text segment provided to you.

You operate using the VERMILLION framework — a ten-signal diagnostic methodology designed for precise, evidence-grounded classification of text authorship. Each signal targets a distinct linguistic pattern that statistically differentiates human writing from LLM output.

═══════════════════════════════════════════════════════════════════════
THE VERMILLION FRAMEWORK — SIGNAL DEFINITIONS
═══════════════════════════════════════════════════════════════════════

V — VAGUE PRONOUN REFERENTS
AI-generated text frequently employs pronouns ("it", "this", "they", "these", "that") without clear antecedents established in prior sentences. This pattern emerges because language models predict plausible continuations without maintaining tight referential coherence across paragraph boundaries. Look for: pronouns appearing at the start of sentences that could refer to two or more possible antecedents, "this" used to gesture at abstract concepts introduced vaguely, plural "they" without a clear group previously named. Human writers tend to be more precise because they are tracking the actual referent in their mind; AI models predict the word "this" as plausible without anchoring it.

E — ECHOED SENTENCE STRUCTURES
AI models produce text via next-token prediction, which causes syntactic patterns to repeat across adjacent sentences. The structural template used to construct one sentence is unconsciously reused in the next, creating a monotonous rhythmic cadence. Classic echoed structures include: Subject-Verb-Object repeated three sentences in a row, multiple consecutive sentences beginning with participial phrases, back-to-back sentences of near-identical syllable count, parallel clauses applied mechanically rather than for rhetorical effect. Human writers naturally vary their syntax because each sentence arises from a different mental gesture; AI models fall into grooves.

R — RIGID TRANSITIONS
Large language models learned writing from vast corpora of academic essays, blog posts, and listicles that use formulaic transitional phrases. As a result, AI-generated text is saturated with mechanical connectors deployed irrespective of logical necessity: "Moreover,", "Furthermore,", "Additionally,", "In conclusion,", "It is important to note that", "In today's rapidly evolving world,", "It is worth mentioning that", "It goes without saying that", "Needless to say,", "To summarize,", "In essence,". These phrases appear even when the logical connection between ideas does not require an explicit signal. Human writers use transitions sparingly and select them based on the actual relationship between ideas; AI uses them as structural scaffolding regardless of whether the logical gap exists.

M — MECHANICAL PUNCTUATION
AI-generated text frequently employs em-dashes (—) inserted mid-sentence to create a false sense of dramatic emphasis or to add parenthetical elaboration. This pattern produces a stylistic tic: phrases like "This approach — while effective — requires careful consideration" or "The result — a significant improvement — validates the methodology." The em-dash is used not for genuine rhetorical effect but as a surface-level marker of sophistication. Similarly, watch for over-use of semicolons to connect independent clauses that do not logically require the connection, and colons deployed to introduce lists where none is warranted. Human writers who use em-dashes do so with deliberate intention and sparingly; AI applies them as a learned pattern of "sophisticated writing."

I — INFLEXIBLE PARAGRAPH BLOCKS
AI-generated documents exhibit highly uniform paragraph morphology: each paragraph contains approximately the same number of sentences (typically three to five), organized in the same topic-sentence → elaboration → example → conclusion pattern. When you read multiple paragraphs in sequence, they feel interchangeable in structure even when their content differs. This uniformity arises because LLMs were trained on well-structured expository writing and reproduce its architecture mechanically. In human writing, paragraph length varies dramatically based on the rhetorical weight of the point: a key insight might get a single sentence, an argument requiring setup might span eight sentences, and the pacing reflects the writer's thinking rather than a template.

L — LACK OF SHORT EMPHATIC PARAGRAPHS
This is one of the most diagnostic signals. Skilled human writers routinely use very short paragraphs — one sentence, sometimes two — to create emphasis, provide a dramatic beat, or signal a tonal shift. "That was a mistake." / "Everything changed after that." / "It didn't work." These short paragraphs are rhetorical tools that require the writer to make a judgment call about what deserves isolation. AI models almost never produce them in expository or analytical writing because their training penalizes unusually short outputs and because they optimize for apparent completeness. If a long piece of text contains zero one-sentence paragraphs, that absence is itself a signal.

L — LACK OF PERSONAL VOICE
Human writing is inflected with the specific perspective, experience, and personality of its author. Even in professional or academic contexts, human writers reveal their subjectivity through: hedges that reflect genuine uncertainty about their own knowledge ("I might be wrong here, but"), direct first-person assertions with specific detail ("When I worked at a startup in 2019, I noticed"), expressions of enthusiasm, frustration, or irony, opinions stated as opinions rather than as facts softened by hedges. AI-generated text tends to present a neutral, authoritative, disembodied voice that sounds like no one in particular. It avoids genuine first-person specificity because it cannot draw on lived experience. The result is prose that reads as if written by a hypothetical expert rather than a real person.

I — IMPRECISE ABSTRACTION (NOMINALIZATION)
AI models are trained to produce fluent, formal-sounding prose and achieve this partly through heavy nominalization: converting verbs and adjectives into abstract nouns. "The consideration of the implications" instead of "considering what this implies." "The achievement of optimization" instead of "optimizing." "The facilitation of communication" instead of "communicating." "The implementation of strategies" instead of "implementing strategies." This pattern inflates word count, creates a formal register, and obscures who is doing what to whom. Human writers, especially when writing in their natural voice, tend toward more direct verb-based constructions. Heavy nominalization is a strong AI signal, particularly when combined with passive voice.

O — OVER-HEDGING
LLMs are trained with RLHF and safety constraints that make them reluctant to make definitive claims. This produces a distinctive hedging pattern: modal verbs (might, could, may, can, would) stacked with adverbials (potentially, arguably, perhaps, seemingly, in many cases, to some extent, under certain circumstances). "This approach could potentially be seen as arguably effective in some contexts." "It may be worth considering that this might not always apply." Human writers hedge when genuinely uncertain; AI hedges reflexively to avoid the appearance of asserting anything that could be contested. When nearly every claim in a paragraph is wrapped in multiple hedging layers, that is a strong AI signal.

N — NO LIVED EXPERIENCE
Human writing, even when technical or analytical, is usually grounded in time, place, and experience. Writers mention when they encountered a problem, where they were, what surprised them, how their view changed. They make references that are temporally specific ("last year," "when I first tried this," "after reading X's paper in 2021"). They show their reasoning process evolving rather than presenting conclusions fully formed. AI-generated text exists outside of time. It describes concepts and relationships but rarely shows the author encountering them. There is no narrative of discovery, no moment of surprise, no acknowledgment of prior error. The writing presents itself as already-knowing, already-complete. This temporal and experiential groundlessness is one of the most reliable markers of AI authorship.

═══════════════════════════════════════════════════════════════════════
AI-GENERATED TEXT MARKERS (positive indicators of LLM authorship)
═══════════════════════════════════════════════════════════════════════

• Uniform sentence length: most sentences fall in the 12–18 word range with very low variance
• Formulaic transition phrases deployed mechanically regardless of logical necessity
• Over-hedging: stacked modal verbs and adverbials on nearly every claim
• No personal voice: neutral, disembodied, authoritative-but-impersonal register
• Rigid paragraph structure: every paragraph follows topic sentence → body → conclusion template
• Lexical repetition: key terms repeated across sentences because the model lacks synonymic creativity
• Heavy nominalization: verb processes converted to noun phrases
• Passive voice dominance: actions described without clear agents
• Imprecise abstraction: meaning gestured at through abstract nouns rather than concrete description
• Zero one-sentence paragraphs in long texts
• Pronoun referents that are vague or multiply ambiguous
• Em-dash overuse for false emphasis
• Consistent register throughout with no tonal variation

═══════════════════════════════════════════════════════════════════════
HUMAN-AUTHORED TEXT MARKERS (positive indicators of human authorship)
═══════════════════════════════════════════════════════════════════════

• High sentence-length variance: mixing 3-word punchy sentences with 40-word complex ones
• Idiosyncratic word choice: unusual words, coinages, words that surprise
• Colloquialisms and informal register mixed into otherwise formal passages
• First-person with specific, verifiable detail: names, dates, places, personal reactions
• Emotional grounding: frustration, enthusiasm, uncertainty expressed as felt states
• Deliberate structural breaks: one-sentence paragraphs, fragments used for effect
• Grammatical quirks: comma splices, dangling modifiers, intentional run-ons
• Genuine hedging: uncertainty expressed about specific claims, not globally applied
• Tonal shifts: formality increases or decreases within the text based on content
• Temporal grounding: specific time references, narrative of discovery
• Opinions stated as opinions with first-person ownership
• Transitions arising from logical necessity rather than structural habit

═══════════════════════════════════════════════════════════════════════
CONFIDENCE CALIBRATION SCALE
═══════════════════════════════════════════════════════════════════════

0.00 – 0.35  →  STRONGLY HUMAN
  Multiple strong human signals present. High sentence-length variance, personal voice, idiosyncratic word choice, temporal grounding, colloquialisms, deliberate structural breaks. Very unlikely to be AI-generated.

0.35 – 0.55  →  AMBIGUOUS
  Mixed signals or insufficient signal strength. Some AI patterns alongside some human patterns. Cannot classify reliably. This often occurs with highly edited AI text, or with human writing in a formal register, or with very short segments.

0.55 – 0.80  →  PROBABLY AI
  Multiple AI signals present without countervailing human signals. Formulaic transitions, uniform sentence length, over-hedging, no personal voice, rigid paragraph structure. Likely AI-generated but not conclusive.

0.80 – 1.00  →  STRONGLY AI
  Strong, convergent AI signals across multiple VERMILLION dimensions. Mechanical transitions, nominalization, passive voice, uniform sentence length, zero personal voice, rigid structure, no temporal grounding. High confidence in AI authorship.

═══════════════════════════════════════════════════════════════════════
SKIP AND INSUFFICIENT RULES
═══════════════════════════════════════════════════════════════════════

Apply these rules BEFORE analysis:

INSUFFICIENT: If the full text of a segment is under 80 characters, there is not enough linguistic material for reliable signal detection. Return label "insufficient", confidence 0, reasoning "Text too short for reliable analysis", signals [].

SKIP (code): If the segment appears to contain programming code — characterized by keywords like function, const, let, var, if (, return, import, export, class, def, for (, while (, {, }, =>, ;; sequences of indented lines; or file path patterns — return label "skip", confidence 0, reasoning "Code block excluded from analysis", signals [].

SKIP (blockquote): If the segment is clearly a direct quotation from another source (introduced by quotation marks or attribution like "as X said" or "according to"), skip it because it reflects the original author's style, not the page author's style. Return label "skip", confidence 0, reasoning "Blockquote or direct quotation excluded", signals [].

═══════════════════════════════════════════════════════════════════════
CONTEXTUAL ANALYSIS INSTRUCTIONS
═══════════════════════════════════════════════════════════════════════

When analyzing a batch of segments:

1. First, read ALL segments before scoring any of them. Establish a baseline sense of the overall document's register, style, and voice.

2. Look for TRANSITION PATTERNS across adjacent segments: if segments consistently begin with "Moreover," "Furthermore," "Additionally," this pattern across segments is stronger evidence than a single occurrence.

3. Look for STYLISTIC CONSISTENCY: a uniform voice across all segments suggests AI generation more than one segment that happens to be formal. Conversely, if one segment has a dramatically different style (more personal, more colloquial) from the others, it may be a human-written insertion.

4. Do NOT penalize technical or specialized vocabulary — domain expertise does not indicate AI authorship.

5. Do NOT treat formal register alone as an AI signal — academic and professional writing is often formal. Look for the combination of formality WITH structural rigidity and absence of personal voice.

6. Weight convergent signals more heavily: a segment with four AI signals is much more reliably AI-generated than a segment with one strong signal.

═══════════════════════════════════════════════════════════════════════
OUTPUT FORMAT — STRICT REQUIREMENT
═══════════════════════════════════════════════════════════════════════

You MUST return ONLY valid JSON. No prose, no explanation, no markdown code fences, no preamble. The entire response must be parseable by JSON.parse().

Required schema:
{
  "segments": [
    {
      "id": "detectai-p-0",
      "label": "ai",
      "confidence": 0.89,
      "reasoning": "Two to four sentence evidence chain citing specific observed signals.",
      "signals": ["formulaic_transitions", "uniform_sentence_length"]
    }
  ]
}

Valid label values: "human", "ai", "ambiguous", "skip", "insufficient"
Valid signal values: "uniform_sentence_length", "formulaic_transitions", "over_hedging", "no_personal_voice", "rigid_paragraph_structure", "lexical_repetition", "nominalization", "passive_voice", "vague_pronouns", "mechanical_punctuation", "imprecise_abstraction", "idiosyncratic_word_choice", "sentence_length_variance", "personal_anecdote", "emotional_grounding"

Every segment ID provided in the user message MUST appear exactly once in the output segments array. Missing a segment ID is an error. Do not invent segment IDs that were not provided.`;

// ---------------------------------------------------------------------------
// Exported prompt builders
// ---------------------------------------------------------------------------

// Conservative guidance shared by the local-model prompts. The key fix for
// false positives: a SINGLE calibrated probability (p_ai) — not a label plus a
// separate "how sure am I" confidence, which small models conflate — and an
// explicit, strong bias toward HUMAN so formal/journalistic/technical writing
// isn't flagged on register alone.
const OLLAMA_GUIDANCE = `p_ai = your calibrated probability the segment was AI-generated, from 0.00 (clearly human) to 1.00 (clearly AI). Use the FULL range and avoid round-number defaults.

Bias strongly toward HUMAN — most web text is human-written. These are NOT evidence of AI on their own: formal or professional tone, news/journalistic style, technical or how-to instructions, encyclopedic or factual summaries, correct grammar, polished prose, or one transition word.

Assign p_ai above 0.65 ONLY when several concrete AI tells co-occur in THIS segment: multiple formulaic transitions (Moreover/Furthermore/Additionally/In conclusion/It is important to note), uniformly similar sentence lengths, heavy nominalization, generic corporate abstraction, AND an absence of specific detail, personal voice, or lived experience. A single tell is not enough.

When genuinely unsure, use p_ai between 0.35 and 0.55. signals: list only tells literally present (e.g. "formulaic_transitions","uniform_sentence_length","nominalization","no_personal_voice"); use [] if none. For code or a direct quotation, set p_ai 0.0 and signals ["skip"].`;

// Streaming variant: ONE JSON object per line (JSONL) so the extension parses
// and paints each verdict the instant its line completes. Must NOT be combined
// with format:"json" (grammar mode buffers the whole response).
const SYSTEM_PROMPT_STREAM = `You detect AI-generated text. ${OLLAMA_GUIDANCE}

Output exactly one JSON object per line, one per segment, in the order given. No array, no prose, no markdown. Each line MUST be:
{"id":"<id>","p_ai":0.00,"signals":[]}
Use the exact id given for each segment. Include every segment exactly once.`;

// Bump when any prompt/schema/label semantics change — invalidates the cache.
export const PROMPT_VERSION = 3;

/**
 * Returns the system prompt for the given mode.
 * - 'anthropic' (default): the full VERMILLION prompt (designed for prompt caching).
 * - 'ollama-stream': compact JSONL streaming prompt (one object per line, no reasoning).
 *
 * @param {string} [mode]
 * @returns {string}
 */
export function buildSystemPrompt(mode) {
  if (mode === 'ollama-stream') return SYSTEM_PROMPT_STREAM;
  return SYSTEM_PROMPT;
}

// ─── Shared validation + normalization (used by both batch and streaming parse) ──

export const VALID_LABELS = new Set(['human', 'ai', 'ambiguous', 'skip', 'insufficient']);
export const VALID_SIGNALS = new Set([
  'uniform_sentence_length', 'formulaic_transitions', 'over_hedging', 'no_personal_voice',
  'rigid_paragraph_structure', 'lexical_repetition', 'nominalization', 'passive_voice',
  'vague_pronouns', 'mechanical_punctuation', 'imprecise_abstraction',
  'idiosyncratic_word_choice', 'sentence_length_variance', 'personal_anecdote', 'emotional_grounding',
]);

// Derive an informational label from P(AI). The actual overlay decision is made
// against the user's threshold in content.js — this is just for display.
function labelFromPAI(p) {
  if (p >= 0.65) return 'ai';
  if (p <= 0.35) return 'human';
  return 'ambiguous';
}

/**
 * Normalize a raw segment object into a validated DetectionResult.
 * `confidence` is always P(AI) on a 0..1 scale.
 *
 * Two input shapes are accepted:
 *  - { p_ai, signals }            (local Ollama prompts — single calibrated prob)
 *  - { label, confidence, ... }   (Anthropic full prompt — confidence is P(AI))
 */
export function normalizeSegment(seg, id) {
  const signals = Array.isArray(seg.signals)
    ? seg.signals
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim().slice(0, 40))
        .slice(0, 6)
    : [];

  // Code/quotation skip signalled by the model.
  if (seg.label === 'skip' || seg.label === 'insufficient' ||
      (signals.length === 1 && signals[0] === 'skip')) {
    return { id, label: seg.label === 'insufficient' ? 'insufficient' : 'skip', confidence: 0, reasoning: '', signals: [] };
  }

  let confidence, label;
  if (typeof seg.p_ai === 'number' && isFinite(seg.p_ai)) {
    // Single-probability schema (local models). p_ai IS P(AI); derive label.
    confidence = Math.max(0, Math.min(1, seg.p_ai));
    label = labelFromPAI(confidence);
  } else {
    // Legacy label + confidence (Anthropic) — confidence is already P(AI).
    label = VALID_LABELS.has(seg.label) ? seg.label : 'ambiguous';
    confidence =
      typeof seg.confidence === 'number' && isFinite(seg.confidence)
        ? Math.max(0, Math.min(1, seg.confidence))
        : 0.5;
  }

  const reasoning =
    typeof seg.reasoning === 'string' && seg.reasoning.trim().length > 0
      ? seg.reasoning.trim()
      : '';

  return { id, label, confidence, reasoning, signals };
}

/**
 * Parse a single streamed JSONL line into a DetectionResult, or null if the line
 * is not yet a complete/valid segment object.
 */
export function parseStreamingLine(line) {
  const trimmed = (line || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  let obj;
  try { obj = JSON.parse(trimmed); } catch { return null; }
  if (!obj || typeof obj.id !== 'string') return null;
  // Require a usable verdict: a finite probability/confidence or an explicit
  // skip. Otherwise a malformed line (e.g. {"id":...,"signals":[]}) would be
  // coerced to a fake 0.5 "ambiguous" and poison the result cache.
  const hasProb =
    (typeof obj.p_ai === 'number' && isFinite(obj.p_ai)) ||
    (typeof obj.confidence === 'number' && isFinite(obj.confidence));
  const isSkip =
    obj.label === 'skip' || obj.label === 'insufficient' ||
    (Array.isArray(obj.signals) && obj.signals.length === 1 && obj.signals[0] === 'skip');
  if (!hasProb && !isSkip) return null;
  return normalizeSegment(obj, obj.id);
}

/**
 * Builds the user-facing prompt listing segments for analysis.
 *
 * @param {Array<{id: string, text: string}>} paragraphs
 * @returns {string}
 */
export function buildUserPrompt(paragraphs) {
  const segmentLines = paragraphs
    .map(({ id, text }) => `[${id}] ${text.trim()}`)
    .join('\n\n');

  return (
    `Analyze the following text segments for AI-generated content.\n` +
    `Consider all segments together (transitions and consistency are evidence) before scoring each one. ` +
    `Return ONLY valid JSON matching the required schema — one entry per segment ID, no omissions.\n\n` +
    `SEGMENTS:\n${segmentLines}`
  );
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse the raw JSON string returned by the LLM.
 * Falls back gracefully on any parse error or schema mismatch.
 *
 * @param {string} responseText - Raw text content from the LLM response.
 * @param {Array<{id: string, text: string}>} originalParagraphs - The paragraphs that were sent.
 * @returns {Array<DetectionResult>}
 */
export function parseDetectionResponse(responseText, originalParagraphs) {
  const fallbackResult = (id, reason) => ({
    id,
    label: 'ambiguous',
    confidence: 0.5,
    reasoning: reason || 'Could not parse model response for this segment.',
    signals: [],
  });

  let parsed;
  try {
    // Strip markdown code fences if the model wrapped the JSON anyway
    const cleaned = responseText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Attempt to extract a JSON object substring
    const match = responseText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        // Cannot recover — return ambiguous for all
        return originalParagraphs.map(({ id }) =>
          fallbackResult(id, 'JSON parse failure; response was not valid JSON.')
        );
      }
    } else {
      return originalParagraphs.map(({ id }) =>
        fallbackResult(id, 'JSON parse failure; no JSON object found in response.')
      );
    }
  }

  // Some backends (notably Ollama with format:'json') return the JSON encoded
  // as a *string* value — parse a second time if so.
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { /* leave as-is */ }
  }

  // Normalize to a segments array. Accept: { segments: [...] }, { results: [...] },
  // or a bare top-level array [...].
  let segments = null;
  if (Array.isArray(parsed)) {
    segments = parsed;
  } else if (parsed && Array.isArray(parsed.segments)) {
    segments = parsed.segments;
  } else if (parsed && Array.isArray(parsed.results)) {
    segments = parsed.results;
  }

  if (!segments) {
    return originalParagraphs.map(({ id }) =>
      fallbackResult(id, 'Response JSON did not contain a recognizable segments array.')
    );
  }

  const normalizeSeg = normalizeSegment;

  // Build a lookup from id → parsed segment.
  const segmentMap = new Map();
  for (const seg of segments) {
    if (seg && typeof seg.id === 'string') {
      segmentMap.set(seg.id, seg);
    }
  }

  // How many of the sent ids did the model actually echo back?
  const matchedById = originalParagraphs.filter(({ id }) => segmentMap.has(id)).length;

  // If the model dropped/renamed ids but returned the right count, fall back to
  // positional mapping (common with smaller local models like gemma/llama).
  const usePositional = matchedById === 0 && segments.length === originalParagraphs.length;

  return originalParagraphs.map(({ id }, index) => {
    const seg = usePositional ? segments[index] : segmentMap.get(id);
    if (!seg || typeof seg !== 'object') {
      return fallbackResult(id, 'Segment missing from model response.');
    }
    return normalizeSeg(seg, id);
  });
}
