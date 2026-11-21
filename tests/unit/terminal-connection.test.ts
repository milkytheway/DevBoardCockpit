import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshConnection } from '../../src/main/hal/ssh';
import { prepareProfile } from '../../src/main/board/prepare';
import { pickCandidates } from '../../src/main/tags/runtime';
import type { ConnectionProfile } from '../../src/main/profiles/schema';
import type { SpawnResult } from '../../src/main/util/spawn';

/**
 * **The connection chain** ✓ — from the profile on the disk to the bytes on
 * the wire ✓.
 *
 * ── Why these judgments and not others ──
 *
 * → **The failure has to name the kind of failure** ✓ ("the host did not
 *   answer" ✓ · "it answered and refused the credential" ✓ · "there is no
 *   credential at all" ✓) — one message for all three ✓ sends the user
 *   looking for a network problem that does not exist ✓.
 * → **The credential has to reach the handshake** ✓ — the key itself ✓, not
 *   the path to it ✓ (ssh2 wants the key ✓).
 *
 * ── How a false positive and a false negative are kept away ──
 *
 * | Danger | How it is avoided |
 * |---|---|
 * | **A false positive** (the test is green while the defect is there) | the judgment goes through the **public path** ✓ (`open()` ✓ · `prepareProfile` ✓) and not through a helper ✓ — a helper could be correct while the caller keeps the old behaviour ✗ |
 * | **A false positive** (the wording is asserted, not the kind) | the assertions are on the **discriminator** ✓ ("the message must not say *cannot reach*" ✓) and not on the sentence ✓ → a rewording does not break the test ✓ · the old message **would** break it ✓ |
 * | **A false negative** (the test is red without a defect) | **no network** ✓ (the ssh2 client is injected ✓) · **no hardware** ✓ · **no clock** ✓ · **no home directory** ✓ (the ssh records are injected ✓) |
 * | **A false negative** (the cause text of the error decides) | the fake client emits a **fixed** error text ✓ → the assertion does not depend on what the operating system says ✓ |
 */

/** The options that were handed to `connect()` ✓ */
interface ConnectOptions {
  host?: string;
  port?: number;
  username?: string;
  privateKey?: Buffer | string;
  password?: string;
  readyTimeout?: number;
}

/**
 * A fake ssh2 client ✓.
 *
 * → It **records the options of the handshake** ✓ (that is what the
 *   credential is judged on ✓).
 * → It **answers with the given failure** ✓ or comes up ✓.
 * → **The callbacks are asynchronous** ✓ (the real ones are ✓) — a fake that
 *   called back synchronously would hide a timing defect ✓.
 */
function fakeClient(
  failure?: { message: string; level?: string },
): { client: unknown; connectOptions: () => ConnectOptions | undefined } {
  const once: Record<string, (err?: unknown) => void> = {};
  const on: Record<string, (err?: unknown) => void> = {};
  let options: ConnectOptions | undefined;
  const client = {
    once(evt: string, cb: (err?: unknown) => void) {
      once[evt] = cb;
      return this;
    },
    off() {
      return this;
    },
    // → **The resident listener** ✓ — the connection registers the error
    //   handler with `on` ✓ (it stays for the life of the link ✓) → a fake
    //   that ignored it would never see the failure ✗ (and the test would
    //   hang instead of failing ✗).
    on(evt: string, cb: (err?: unknown) => void) {
      on[evt] = cb;
      return this;
    },
    connect(opts: ConnectOptions) {
      options = opts;
      setTimeout(() => {
        if (failure === undefined) once['ready']?.();
        else on['error']?.(Object.assign(new Error(failure.message), { level: failure.level }));
      }, 0);
      return this;
    },
    end() {
      /* no-op */
    },
  };
  return { client, connectOptions: () => options };
}

/** The session log the connection needs ✓ (it is never written to in these tests ✓) */
const log = { write: () => {}, writeEvent: () => {}, close: () => {} } as never;

const BOARD_PROFILE: ConnectionProfile = {
  id: 'board-ssh',
  label: 'Board · SSH',
  transport: 'ssh',
  board_pack: 'rk3588-atk',
  device_key: 'ATK-DLRK3588',
  options: { host: '192.168.5.100', port: 22, username: 'root', pty: true },
};

describe('the connection chain · the credential reaches the handshake', () => {
  it('**the key itself is handed to ssh2** ✓ (a path is not a key ✓)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-key-'));
    const keyFile = join(dir, 'id_ed25519_codex_board');
    writeFileSync(keyFile, 'THE-KEY-CONTENT', 'utf8');

    const fake = fakeClient();
    const connection = new SshConnection(
      { ...BOARD_PROFILE, options: { ...BOARD_PROFILE.options, key_filename: keyFile } },
      log,
      { clientFactory: () => fake.client as never },
    );
    await connection.open();

    const options = fake.connectOptions();
    // → **The content** ✓ (ssh2 parses the key ✓ — given a path it tries to
    //   parse the path as key content ✗ → "Unsupported key format" ✗).
    expect(String(options?.privateKey)).toBe('THE-KEY-CONTENT');
  });

  it('**a profile without a credential hands no key to ssh2** ✓ (and then the failure says so ✓)', async () => {
    const fake = fakeClient();
    const connection = new SshConnection(BOARD_PROFILE, log, {
      clientFactory: () => fake.client as never,
    });
    await connection.open();
    expect(fake.connectOptions()?.privateKey).toBeUndefined();
  });

  it('**the handshake does not wait 20 seconds** ✓ (the default of ssh2 ✓ → the interface looks hung ✓)', async () => {
    const fake = fakeClient();
    const connection = new SshConnection(BOARD_PROFILE, log, {
      clientFactory: () => fake.client as never,
    });
    await connection.open();
    expect(fake.connectOptions()?.readyTimeout).toBe(8000);
  });
});

describe('the connection chain · the failure names the kind of failure', () => {
  it('**the host refused the credential → it says so** ✓ (and NOT that the host could not be reached ✓)', async () => {
    const fake = fakeClient({ message: 'All configured authentication methods failed', level: 'client-authentication' });
    const connection = new SshConnection(BOARD_PROFILE, log, {
      clientFactory: () => fake.client as never,
    });
    const err = await connection.open().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    // → **The discriminator** ✓ — the old message said "cannot reach" ✓ →
    //   this is the judgment that catches it ✓.
    expect(err?.message).not.toMatch(/cannot reach/i);
    expect(err?.message).toMatch(/credential/i);
    // → The host is named ✓ (the person has to know which one ✓).
    expect(err?.message).toMatch(/192\.168\.5\.100/);
  });

  it('**the host did not answer → it says that** ✓ (and not that the credential was refused ✓)', async () => {
    const fake = fakeClient({ message: 'connect ECONNREFUSED 192.168.5.100:22', level: 'client-socket' });
    const connection = new SshConnection(BOARD_PROFILE, log, {
      clientFactory: () => fake.client as never,
    });
    const err = await connection.open().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/cannot reach/i);
    expect(err?.message).not.toMatch(/credential/i);
  });

  it('**there was no credential at all → it says that** ✓ (a third kind ✓)', async () => {
    const fake = fakeClient({ message: 'All configured authentication methods failed', level: 'client-authentication' });
    const connection = new SshConnection(BOARD_PROFILE, log, {
      clientFactory: () => fake.client as never,
    });
    const err = await connection.open().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).not.toMatch(/cannot reach/i);
    expect(err?.message).toMatch(/no credential/i);
  });
});

describe('the connection chain · the repair reaches the wire', () => {
  /** A runner that answers the adb questions ✓ */
  function runnerOf(answers: { devices?: string; address?: string; model?: string }) {
    return async (_command: string, args: string[]): Promise<SpawnResult> => {
      const key = args.join(' ');
      if (key.includes('devices')) {
        return { exitCode: 0, stdout: answers.devices ?? '', stderr: '', durationMs: 1, timedOut: false };
      }
      if (key.includes('ip -4 addr show')) {
        return { exitCode: 0, stdout: answers.address ?? '', stderr: '', durationMs: 1, timedOut: false };
      }
      if (key.includes('device-tree/model')) {
        return { exitCode: 0, stdout: answers.model ?? '', stderr: '', durationMs: 1, timedOut: false };
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    };
  }

  it('**the detected address and the found key are what the handshake carries** ✓', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-user-profiles-'));
    const keyDir = mkdtempSync(join(tmpdir(), 'cockpit-keys-'));
    const keyFile = join(keyDir, 'id_ed25519_codex_board');
    writeFileSync(keyFile, 'THE-BOARD-KEY', 'utf8');

    // → The profile of a **fresh machine** ✓: the placeholder address ✓ and
    //   **no credential at all** ✓ (that is how it shipped ✓).
    const profile: ConnectionProfile = {
      ...BOARD_PROFILE,
      options: { host: '192.0.2.100', port: 22, username: 'root', pty: true },
    };

    const prepared = await prepareProfile(profile, {
      userProfilesDir: dir,
      runner: runnerOf({
        devices: 'f34dca7784396ab2\tdevice',
        address: '    inet 192.168.5.100/24 scope global eth0',
        model: 'ATK-DLRK3588 Board',
      }),
      expectedModels: ['ATK-DLRK3588'],
      ssh: { addresses: ['192.168.136.131'], keys: [keyFile] },
      probeAddress: async () => true,
      probeCredential: async (_target, candidate) => candidate.path === keyFile,
    });

    // → The profile that comes out ✓ carries the address of the board ✓ and
    //   the key of the board ✓.
    expect(prepared.options['host']).toBe('192.168.5.100');
    expect(prepared.options['key_filename']).toBe(keyFile);

    // → **And that profile is what the handshake carries** ✓ (the repair is
    //   not a side effect ✓ — it is what is connected with ✓).
    const fake = fakeClient();
    const connection = new SshConnection(prepared, log, {
      clientFactory: () => fake.client as never,
    });
    await connection.open();
    expect(fake.connectOptions()?.host).toBe('192.168.5.100');
    expect(String(fake.connectOptions()?.privateKey)).toBe('THE-BOARD-KEY');
  });

  it('**the key of the guest never opens the board** ✓ (a key is bound to its host ✓)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-user-profiles-'));
    const keyDir = mkdtempSync(join(tmpdir(), 'cockpit-keys-'));
    const boardKey = join(keyDir, 'id_ed25519_codex_board');
    const guestKey = join(keyDir, 'id_ed25519_codex_vm');
    writeFileSync(boardKey, 'THE-BOARD-KEY', 'utf8');
    writeFileSync(guestKey, 'THE-GUEST-KEY', 'utf8');

    const prepared = await prepareProfile(
      { ...BOARD_PROFILE, options: { host: '192.0.2.100', port: 22, username: 'root', pty: true } },
      {
        userProfilesDir: dir,
        runner: runnerOf({
          devices: 'f34dca7784396ab2\tdevice',
          address: '    inet 192.168.5.100/24 scope global eth0',
          model: 'ATK-DLRK3588 Board',
        }),
        expectedModels: ['ATK-DLRK3588'],
        ssh: { addresses: ['192.168.136.131'], keys: [guestKey, boardKey] },
        probeAddress: async () => true,
        // → **Only the guest's key authenticates at the guest** ✓ → the board
        //   must not get the guest's key ✓.
        probeCredential: async (target, candidate) =>
          target.host === '192.168.136.131' && candidate.path === guestKey,
      },
    );

    // → **No key authenticates at the board** ✓ → the profile carries none ✓
    //   (a wrong key is worse than no key ✓ — the failure then names the
    //   credential ✓).
    expect(prepared.options['key_filename']).toBeUndefined();
  });
});

describe('the connection chain · the fake board is not a candidate', () => {
  const profile = (id: string): ConnectionProfile => ({
    id,
    label: id,
    transport: 'ssh',
    board_pack: 'rk3588-atk',
    device_key: id,
    options: { host: 'h', port: 22 },
  });

  it('**the profiles without a board pack are not candidates** ✓', () => {
    const profiles = [
      profile('board-ssh'),
      { ...profile('local'), board_pack: null },
      { ...profile('ubuntu-ssh'), board_pack: null },
    ];
    expect(pickCandidates(profiles).map((c) => c.profileId)).toEqual(['board-ssh']);
  });

  it('**the fake board is kept out of the running** ✓ (it is synthetic data ✓ and it always connects ✓)', () => {
    const profiles = [profile('board-ssh'), profile('fake-board')];
    const candidates = pickCandidates(profiles, { exclude: ['fake-board'] });
    expect(candidates.map((c) => c.profileId)).toEqual(['board-ssh']);
  });

  it('**without the exclusion the fake board would win the race** ✓ (the bug this guards ✓)', () => {
    // → The fake board carries a board pack ✓ → it is a candidate ✓ → it
    //   always connects ✓ → it would take the role of the real board ✓.
    const profiles = [profile('board-ssh'), profile('fake-board')];
    expect(pickCandidates(profiles).map((c) => c.profileId)).toContain('fake-board');
  });
});
