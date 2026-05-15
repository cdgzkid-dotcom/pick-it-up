import Anthropic from '@anthropic-ai/sdk';
import { sendTelegramMessage } from '@/lib/telegram';

const MODEL = 'claude-sonnet-4-6';

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  _client = new Anthropic({ apiKey });
  return _client;
}

export interface ClaudeJsonOptions {
  maxTokens?: number;
  /** JSON-parse retry: if parsing fails, re-send with an error hint. Default true. */
  retry?: boolean;
  /** Short label identifying the game/batch for Telegram alerts on API errors. */
  gameLabel?: string;
}

// Exponential backoff for 529 (Overloaded): wait before each retry.
// Attempt 1 fires immediately; delays precede attempts 2, 3, 4.
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
const MAX_ATTEMPTS = 4;

export async function callClaudeJson<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  options: ClaudeJsonOptions = {},
): Promise<T> {
  const { maxTokens = 8192, retry = true, gameLabel } = options;
  const c = client();

  /** Single call to the Anthropic API, returns raw text. */
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

  /**
   * Wraps `send` with 529-specific exponential backoff.
   * - 529 (Overloaded): retry up to MAX_ATTEMPTS with increasing delays.
   *   On exhaustion → Telegram alert, then throw.
   * - Any other error: Telegram alert immediately, then throw.
   */
  const sendWithRetry = async (extraSystem = ''): Promise<string> => {
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
      }
      try {
        return await send(extraSystem);
      } catch (err) {
        const is529 = err instanceof Anthropic.APIError && err.status === 529;

        if (!is529) {
          // Non-overload error: surface immediately, no retries.
          const errType =
            err instanceof Anthropic.APIError
              ? `${err.status} ${err.name}`
              : String(err).slice(0, 80);
          const label = gameLabel ?? 'desconocido';
          void sendTelegramMessage(
            `⚠️ Anthropic API error (${errType}) para ${label}. El análisis falló.`,
          );
          throw err;
        }

        lastErr = err;
        console.warn(
          `[claude] 529 overloaded — attempt ${attempt + 1}/${MAX_ATTEMPTS}`,
          gameLabel ?? '',
        );
      }
    }

    // All MAX_ATTEMPTS exhausted on 529.
    const label = gameLabel ?? 'desconocido';
    void sendTelegramMessage(
      `⚠️ Anthropic API saturada (529) — ${MAX_ATTEMPTS} intentos fallidos para ${label}. El análisis se saltó.`,
    );
    throw lastErr;
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

  const raw = await sendWithRetry();
  try {
    return tryParse(raw);
  } catch (firstErr) {
    if (!retry) throw firstErr;
    const raw2 = await sendWithRetry(
      `Tu respuesta anterior no fue JSON válido (${(firstErr as Error).message}). Devuelve SOLO el objeto JSON, sin texto, sin markdown, sin explicaciones.`,
    );
    return tryParse(raw2);
  }
}
