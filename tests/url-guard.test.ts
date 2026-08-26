import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isPrivateAddress, BlockedUrlError } from '@/lib/url-guard';

describe('isPrivateAddress', () => {
  it('blocks the ranges an SSRF actually targets', () => {
    // The cloud metadata endpoint is the prize; the rest is internal network.
    for (const ip of [
      '169.254.169.254', '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1',
      '172.31.255.255', '192.168.1.1', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('blocks IPv6 loopback, link-local, ULA and IPv4-mapped internals', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:169.254.169.254']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows real public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http schemes', async () => {
    for (const u of ['file:///etc/passwd', 'gopher://x/', 'ftp://example.com/']) {
      await expect(assertPublicUrl(u)).rejects.toBeInstanceOf(BlockedUrlError);
    }
  });

  it('rejects internal hosts given as IP literals', async () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:3000/',
      'http://[::1]/',
      'https://10.0.0.5/menu.pdf',
    ]) {
      await expect(assertPublicUrl(u)).rejects.toBeInstanceOf(BlockedUrlError);
    }
  });

  it('rejects odd ports even on a public host', async () => {
    await expect(assertPublicUrl('http://example.com:22/')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects a hostname that resolves to loopback', async () => {
    // localhost resolves to 127.0.0.1 / ::1 — the DNS path, not the literal one.
    await expect(assertPublicUrl('http://localhost/')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('allows an ordinary restaurant URL', async () => {
    const url = await assertPublicUrl('https://example.com/menu');
    expect(url.hostname).toBe('example.com');
  });
});
