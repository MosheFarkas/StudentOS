import { z } from 'zod';

/** Error codes the web client branches on. Keep this list short and stable. */
export const apiErrorCodeSchema = z.enum([
  'unauthorized',
  'not_found',
  'validation_failed',
  /** Student hit their platform-tier token allowance for the window. */
  'quota_exceeded',
  /** No usable provider: no BYOK key on file and the platform tier is off. */
  'no_provider_configured',
  /** The student's own API key was rejected by the upstream provider. */
  'provider_key_invalid',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export class ContextoError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContextoError';
  }
}
