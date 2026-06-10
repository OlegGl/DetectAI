/**
 * text-chunker.js
 * ES6 module — helpers for segments that are too short for reliable analysis.
 * (Chunking itself lives inline in api-client's detectTextBatch.)
 */

/**
 * Build DetectionResult objects for paragraphs that were too short to analyze.
 *
 * @param {Array<{id: string, text: string}>} insufficients
 * @returns {Array<DetectionResult>}
 */
export function buildInsufficientResults(insufficients) {
  return insufficients.map(({ id }) => ({
    id,
    label: 'insufficient',
    confidence: 0,
    reasoning: 'Text too short for reliable analysis.',
    signals: [],
  }));
}
