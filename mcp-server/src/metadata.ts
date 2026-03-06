import { OLLAMA_URL } from './embeddings.js';

const LLM_MODEL = process.env.LLM_MODEL || 'llama3.2';

interface ExtractedMetadata {
  people: string[];
  dates: string[];
  topics: string[];
  type: string;
  summary: string;
}

const SYSTEM_PROMPT = `You are a metadata extractor. Given a text, extract structured metadata as JSON.
Return ONLY valid JSON with these fields:
- people: array of person names mentioned
- dates: array of date references (exact or relative like "yesterday", "last week")
- topics: array of 1-5 topic keywords
- type: one of "fact", "preference", "decision", "note", "idea", "reference", "conversation"
- summary: one-sentence summary (max 100 chars)

If a field has no matches, use an empty array or "note" for type.`;

export async function extractMetadata(content: string): Promise<ExtractedMetadata> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        prompt: content,
        system: SYSTEM_PROMPT,
        format: 'json',
        stream: false,
        options: { temperature: 0.1, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return fallbackExtract(content);
    const data = await res.json() as { response?: string };
    if (!data.response) return fallbackExtract(content);
    const parsed = JSON.parse(data.response) as Partial<ExtractedMetadata>;
    return {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      type: typeof parsed.type === 'string' ? parsed.type : 'note',
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 100) : '',
    };
  } catch {
    return fallbackExtract(content);
  }
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'that', 'this', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'and', 'but', 'or', 'nor', 'not', 'so', 'very', 'just', 'about', 'up', 'if', 'no', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'than', 'too', 'also']);

// Heuristic fallback when LLM is unavailable
function fallbackExtract(content: string): ExtractedMetadata {
  // People: capitalized word pairs
  const people = [...content.matchAll(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/g)].map(m => m[1]).slice(0, 5);

  // Dates: common patterns
  const datePatterns = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:yesterday|today|tomorrow|last (?:week|month|year)|next (?:week|month|year)))\b/gi;
  const dates = [...content.matchAll(datePatterns)].map(m => m[1]).slice(0, 5);

  // Topics: most frequent non-stop words
  const words = content.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (!STOP_WORDS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const topics = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);

  return { people, dates, topics, type: 'note', summary: content.slice(0, 100) };
}
