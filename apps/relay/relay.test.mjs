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

  /*
   * Answered from a resolver we choose, not from DNS.
   *
   * This used to ask the real resolver about example.com, which made a
   * security test depend on the network: it failed on a DNS hiccup, and a
   * guard whose test cannot be trusted is a guard nobody will trust. Choosing
   * the answer also covers the case that matters most and could not be
   * written before -- a public-looking name that resolves inward.
   */
  const resolvesTo =
    (...addresses) =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('allows a host that resolves to a public address', async () => {
    await expect(
      assertPublicHost('example.com', resolvesTo('93.184.216.34')),
    ).resolves.toBeUndefined();
  });

  it('refuses a public-looking name that resolves inward', async () => {
    // DNS rebinding: the name says nothing, the answer is everything.
    await expect(
      assertPublicHost('totally-fine.example', resolvesTo('127.0.0.1')),
    ).rejects.toThrow();
    await expect(
      assertPublicHost('totally-fine.example', resolvesTo('169.254.169.254')),
    ).rejects.toThrow();
  });

  it('refuses when any one answer is internal, not just the first', async () => {
    // A host answering with one public and one internal address must not be
    // reachable at all -- otherwise which one is used becomes a race.
    await expect(
      assertPublicHost('mixed.example', resolvesTo('93.184.216.34', '10.0.0.5')),
    ).rejects.toThrow();
  });

  it('refuses a name that resolves to nothing', async () => {
    await expect(assertPublicHost('empty.example', resolvesTo())).rejects.toThrow();
  });

  it('refuses a name that cannot be resolved at all', async () => {
    const fails = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertPublicHost('nope.example', fails)).rejects.toThrow(/host not found/);
  });
});

/**
 * The spelling the URL parser actually produces.
 *
 * "[::ffff:169.254.169.254]" comes back out of `new URL()` as
 * "[::ffff:a9fe:a9fe]", and only the dotted spelling was recognised as
 * IPv4-mapped -- so the relay would have forwarded a request to cloud
 * metadata written that way.
 */
describe('ipv4-mapped addresses in hex form', () => {
  it('recognises hex-form metadata and loopback as forbidden', () => {
    expect(isForbiddenAddress('::ffff:a9fe:a9fe')).toBe(true);
    expect(isForbiddenAddress('::ffff:7f00:1')).toBe(true);
  });

  it('still allows a genuinely public mapped address', () => {
    expect(isForbiddenAddress('::ffff:5db8:d822')).toBe(false);
  });

  it('rejects a bracketed literal without consulting a resolver', async () => {
    const wouldAllow = async () => [{ address: '93.184.216.34', family: 4 }];
    await expect(assertPublicHost('[::1]', wouldAllow)).rejects.toThrow(/not allowed/);
    await expect(assertPublicHost('[::ffff:a9fe:a9fe]', wouldAllow)).rejects.toThrow(/not allowed/);
  });
});
