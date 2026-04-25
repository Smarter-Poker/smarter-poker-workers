/**
 * Grok client — minimal port of World Hub's src/lib/grokClient.js.
 * OpenAI-compatible wrapper pointed at x.ai's API. Single env var: XAI_API_KEY.
 *
 * Usage: const grok = getGrokClient(); await grok.chat.completions.create({...});
 */
import OpenAI from 'openai';

let cached: OpenAI | null = null;

export function getGrokClient(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('[grok] XAI_API_KEY not set');
  cached = new OpenAI({
    apiKey,
    baseURL: 'https://api.x.ai/v1',
  });
  return cached;
}
