import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  _client = new Anthropic({ apiKey });
  return _client;
}

export async function callClaudeJson<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 8192,
): Promise<T> {
  const c = client();

  const send = async (extraSystem = ''): Promise<string> => {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt + (extraSystem ? '\n\n' + extraSystem : ''),
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('No text block in response');
    return block.text;
  };

  const tryParse = (raw: string): T => {
    let txt = raw.trim();
    if (txt.startsWith('```')) {
      txt = txt.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
    }
    const start = txt.indexOf('{');
    const end = txt.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found');
    return JSON.parse(txt.slice(start, end + 1)) as T;
  };

  let raw = await send();
  try {
    return tryParse(raw);
  } catch (firstErr) {
    raw = await send(
      `Tu respuesta anterior no fue JSON válido (${(firstErr as Error).message}). Devuelve SOLO el objeto JSON, sin texto, sin markdown, sin explicaciones.`,
    );
    return tryParse(raw);
  }
}
