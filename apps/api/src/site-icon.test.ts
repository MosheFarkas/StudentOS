import { describe, expect, it, vi } from 'vitest';
import { lookupSiteIcon } from './site-icon.js';

const answering = (status: number, type: string, body = 'x') =>
  vi.fn(
    async () => new Response(body, { status, headers: { 'content-type': type } }),
  ) as unknown as typeof fetch;

describe('lookupSiteIcon', () => {
  it('hands back the icon the lookup has', async () => {
    const fetchImpl = answering(200, 'image/png', 'png-bytes');
    const icon = await lookupSiteIcon('portals.veracross.com', fetchImpl);

    expect(icon?.type).toBe('image/png');
    expect(new TextDecoder().decode(icon?.bytes)).toBe('png-bytes');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://icons.duckduckgo.com/ip3/portals.veracross.com.ico',
      expect.anything(),
    );
  });

  /** The "unknown site" placeholder arrives as a 404 with a picture in it. */
  it('treats an unknown site as nothing, picture or not', async () => {
    expect(await lookupSiteIcon('no-such-host.invalid', answering(404, 'image/png'))).toBeNull();
  });

  it('treats anything that is not an image as nothing', async () => {
    expect(await lookupSiteIcon('example.com', answering(200, 'text/html'))).toBeNull();
  });

  it('never asks about something that is not a hostname', async () => {
    const fetchImpl = answering(200, 'image/png');
    expect(await lookupSiteIcon('not a host/../etc', fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is nothing rather than an error when the lookup is down', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await lookupSiteIcon('example.com', failing)).toBeNull();
  });
});
