/**
 * text-chunker.js
 * ES6 module — splits paragraph arrays into API-sized chunks,
 * separating out segments that are too short for reliable analysis.
 */

/**
 * Split paragraphs into processable chunks, pulling out short segments first.
 *
 * @param {Array<{id: string, text: string}>} paragraphs
 * @param {number} [chunkSize=10]
 * @returns {{ chunks: Array<Array<{id: string, text: string}>>, insufficients: Array<{id: string, text: string}> }}
 */
export function chunkParagraphs(paragraphs, chunkSize = 10) {
  const insufficients = [];
  const eligible = [];

  for (const p of paragraphs) {
    if (!p || typeof p.text !== 'string') {
      continue;
    }
    if (p.text.trim().length < 80) {
      insufficients.push(p);
    } else {
      eligible.push(p);
    }
  }

  const chunks = [];
  for (let i = 0; i < eligible.length; i += chunkSize) {
    chunks.push(eligible.slice(i, i + chunkSize));
  }

  return { chunks, insufficients };
}

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
