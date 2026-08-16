import { describe, expect, it } from 'vitest';
import { isForbiddenAddress, assertPublicHost } from './relay.mjs';

/**
 * This process runs on a home network, beside a router and whatever else is
 * on that LAN, and it makes HTTP requests on instruction from a server on the
 * public internet. The address rules are the only thing standing between that
 * arrangement and a window onto the house.
 *
 * These duplicate packages/agent/src/tools/web/fetch.test.ts on purpose: the
 * relay is a single dependency-free file so it can run anywhere with nothing
 * installed, which means its copy of the rules needs its own coverage.
 */
describe('isForbiddenAddress', () => {
  it.each([
    ['home router', '192.168.1.1'],
    ['home LAN', '192.168.0.42'],
    ['private 10/8', '10.0.0.1'],
    ['private 172.16/12', '172.20.10.5'],
    ['loopback', '127.0.0.1'],
    ['all-zeros', '0.0.0.0'],
    ['cloud metadata', '169.254.169.254'],
    ['carrier NAT', '100.64.0.1'],
    ['multicast', '239.255.255.250'],
    ['ipv6 loopback', '::1'],
    ['ipv6 link-local', 'fe80::1'],
    ['ipv6 unique-local', 'fd00::1'],
    ['ipv4-mapped router', '::ffff:192.168.1.1'],
    ['not an address', 'nonsense'],
  ])('refuses %s', (_label, ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each([
    ['a public v4', '208.80.154.224'],
    ['a public v6', '2620:0:861:ed1a::1'],
  ])('allows %s', (_label, ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
});

describe('assertPublicHost', () => {
  it('refuses a literal private address', async () => {
    await expect(assertPublicHost('192.168.1.1')).rejects.toThrow();
  });

  /**
   * The case a string check misses. "localhost" is not an IP literal, so it
   * has to be resolved before being judged -- and a hostname an attacker
   * controls can point anywhere they like.
   */
  it('refuses a hostname that resolves inward', async () => {
    await expect(assertPublicHost('localhost')).rejects.toThrow();
  });

  it('allows a genuinely public host', async () => {
    await expect(assertPublicHost('example.com')).resolves.toBeUndefined();
  });
});
