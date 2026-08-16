import type { AudioTranscriber } from '@contexto/agent';
import { TRANSCRIPTION_MODEL } from '@contexto/llm';

/**
 * Speech-to-text over the platform's OpenAI key.
 *
 * Kept out of the agent package for the same reason token minting is: that
 * package knows how to get audio out of a video and nothing about which
 * vendor turns it into words.
 *
 * Deliberately NOT metered against the student's token quota. Quotas count
 * tokens, transcription is billed per minute, and folding one into the other
 * would make both numbers meaningless. Worth revisiting if it turns into real
 * money -- a class video is roughly a cent.
 */
export class OpenAiTranscriber implements AudioTranscriber {
  constructor(private readonly apiKey: string) {}

  async transcribe(audio: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    // Copied into a standalone buffer: Blob needs a plain ArrayBuffer, and a
    // Uint8Array view may be a window onto a larger one.
    form.append('file', new Blob([audio.slice().buffer as ArrayBuffer]), filename);
    form.append('model', TRANSCRIPTION_MODEL);
    form.append('response_format', 'text');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`transcription failed (${response.status})`);
    }
    return await response.text();
  }
}
