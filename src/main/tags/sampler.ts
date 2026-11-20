import type { BoardPack, ReaderDef } from './schema';
import { getKind, type ReaderContext } from './kinds';
import { buildGroupCommand, splitSections } from './fetch';
import { bindSampleToTag, matchTagPattern, unitForTag } from './vocabulary';
import { makeError, AppError } from '../../shared/errors';
import type { TagStore } from './store';
import type { ExecResult } from '../hal/connection';
import type { ReasonCode } from '../../shared/tag-reading';

/**
 * The sampler — it strings the earlier pieces together:
 * fetch → split → parse per reader → bind the samples to tags → put them in
 * the store.
 *
 * ── It is "one round trip of one group" ──
 *
 * A poll group = one round trip (contract section 1.2): all the readers of
 * the group are composed into one command, fetched in one go.
 *
 * ── Why the parsing state of a reader lives here ──
 *
 * `proc_stat` needs two samples to be differenced (contract section 2.4).
 * That history belongs to this reader on this connection, so it is kept in
 * the sampler — not in the kind (that would give two connections a shared
 * history) and not in the store (that is where the readings meet, not the
 * sampling state).
 */

export interface ExecRunner {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
}

/** The reason when one round trip fails */
function reasonForError(err: unknown): ReasonCode {
  if (err instanceof AppError && err.code === 'CONN_TIMEOUT') return 'timeout';
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out/i.test(message)) return 'timeout';
  return 'service_down';
}

export class TagSampler {
  /** The parsing state of each reader (the history between two samples) */
  private readonly contexts = new Map<string, ReaderContext>();

  constructor(
    private readonly pack: BoardPack,
    private readonly connection: ExecRunner,
    private readonly store: TagStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The parsing context of one reader (one per reader) */
  private contextFor(readerId: string): ReaderContext {
    let ctx = this.contexts.get(readerId);
    if (ctx === undefined) {
      ctx = { state: {} };
      this.contexts.set(readerId, ctx);
    }
    return ctx;
  }

  /** Find a reader in the pack (readers or custom) */
  private findReader(readerId: string): ReaderDef {
    const reader = [...this.pack.readers, ...this.pack.custom].find((r) => r.id === readerId);
    if (reader === undefined) {
      throw makeError('PACK_INVALID', `the pack has no reader "${readerId}"`, {
        detail: { readerId, pack: this.pack.id },
      });
    }
    return reader;
  }

  /**
   * Sample one poll group.
   *
   * The readers of this group share one round trip — so their fetch
   * fragments are composed into one command.
   */
  async sampleGroup(groupId: string): Promise<void> {
    const group = this.pack.poll_groups.find((g) => g.id === groupId);
    if (group === undefined) {
      throw makeError('PACK_INVALID', `the pack has no poll group "${groupId}"`, {
        detail: { groupId, pack: this.pack.id },
      });
    }

    const readers = group.readers.map((id) => this.findReader(id));

    // The fetch fragments.
    // A reader that needs a remote path (`script`): while the runtime has
    // not pushed the script onto the board, it does not build the command
    // that is bound to fail — it reports honestly that it was not pushed.
    const plans: { id: string; fragment: string }[] = [];
    // The readers that did not get into this command (the runtime is not ready yet) — the next round must not report it again
    const skipped = new Set<string>();
    for (const r of readers) {
      const kind = getKind(r.kind);
      if (kind === undefined) {
        throw makeError('PACK_INVALID', `the kind "${r.kind}" of reader "${r.id}" is not in the v1 list`, {
          detail: { readerId: r.id, kind: r.kind },
        });
      }
      const args = r.args ?? {};
      if (kind.needsRemotePath === true && typeof args['remote_path'] !== 'string') {
        this.reportStatus(
          r,
          'unavailable',
          'service_down',
          'the script has not been pushed to the board yet (the runtime did not give a remote_path) — pushing the script is the runtime\'s job (contract §3.3)',
        );
        skipped.add(r.id);
        continue;
      }
      plans.push({ id: r.id, fragment: kind.fetch(args) });
    }
    if (plans.length === 0) return;

    const groupCommand = buildGroupCommand(plans);

    let stdout: string;
    try {
      const result = await this.connection.exec(groupCommand.command);
      if (result.timedOut) {
        // The transport layer may carry a "what to check next" (the first suspect of a serial timeout is the port being held by another program)
        const detail = result.hint ?? 'this round trip timed out (Fact G1: 124 in every case)';
        for (const reader of readers) {
          this.reportRoundTripFailure(reader, 'timeout', detail);
        }
        return;
      }
      stdout = result.stdout;
    } catch (err) {
      const reason = reasonForError(err);
      const detail = err instanceof Error ? err.message : String(err);
      for (const reader of readers) {
        this.reportRoundTripFailure(reader, reason, detail);
      }
      return;
    }

    const sections = splitSections(stdout, groupCommand.markers);

    for (const reader of readers) {
      // A reader that already reported "not pushed" must not report "this section got no reply" again
      if (skipped.has(reader.id)) continue;
      const section = sections.get(reader.id);
      if (section === null || section === undefined) {
        // This section did not run (the marker never appeared)
        this.reportRoundTripFailure(reader, 'service_down', 'there is no reply for this section');
        continue;
      }
      if (!section.complete) {
        // It was truncated (the board only replied half) — half data is
        // not published.
        // Contract section 2.1.1: "it was read but the value is broken" is
        // an error, not an ok.
        // Publishing a `format: integer` 1000 cut to 100 as if it were a
        // normal value is a false number.
        this.reportStatus(
          reader,
          'error',
          'parse_error',
          'this section got no end marker — the board only replied halfway (half data is not published)',
        );
        continue;
      }

      const kind = getKind(reader.kind)!;
      const result = kind.parse(section.text, reader.args ?? {}, this.contextFor(reader.id));

      if (result.status === 'unavailable' || result.status === 'error') {
        // "the resource is not there" and "it was read but it is broken" are
        // two different things (contract section 2.1.1): the first one has
        // to send the user to mount debugfs, the second one is "the read
        // failed".
        this.reportStatus(reader, result.status, result.reason, result.detail);
        continue;
      }

      if (result.status === 'pending') {
        // The first read: there is no sample yet. A tag without a wildcard
        // can already be reported as pending; the concrete name of a tag
        // with a wildcard is not known yet (it comes with the second
        // sampling).
        for (const p of reader.provides) {
          if (p.tag.includes('*')) continue;
          this.store.put({
            tag: p.tag,
            value: null,
            unit: unitForTag(p.tag),
            status: 'pending',
            at: this.now(),
          });
        }
        continue;
      }

      // ok: bind the samples to the tags
      for (const p of reader.provides) {
        for (const [sampleName, value] of Object.entries(result.samples)) {
          const tag = bindSampleToTag(p.tag, p.sample, sampleName);
          if (tag === null) continue;
          this.store.put({
            tag,
            value,
            unit: unitForTag(tag),
            status: 'ok',
            at: this.now(),
          });
        }
      }
    }
  }

  /**
   * This reader is unavailable or broken: all of its tags report the same
   * status.
   *
   * ── What to do with a wildcard tag (the hole of C27) ──
   *
   * → On the first read the concrete name of a wildcard tag is not known
   *   yet → skip it (do not guess)
   * → But after a read the concrete names are known → skipping it then is
   *   a hole (a `cpu` reader that fails completely leaves
   *   `cpu.core.3.usage` at `ok` with the old value → the cards that depend
   *   on it are not judged degraded → stale data is taken for fresh)
   *
   * → The fix: mark the instances that have already been read (use the
   *   known ones — do not invent one)
   * → Contract section 2.3 says it anyway ("the refresh stopped → stale") —
   *   this is a hole of the implementation, it needs no new concept in the
   *   contract (a family level status? not needed — every member of the
   *   family marks itself, that is enough).
   */
  private reportStatus(
    reader: ReaderDef,
    status: 'unavailable' | 'error',
    reason: ReasonCode,
    detail: string,
  ): void {
    for (const p of reader.provides) {
      if (p.tag.includes('*')) {
        // Mark the known instances (do not guess — use the ones that were read)
        for (const tag of this.knownInstancesOf(p.tag)) {
          this.store.put({
            tag,
            value: null,
            unit: unitForTag(tag),
            status,
            reason,
            detail,
            at: this.now(),
          });
        }
        continue;
      }
      this.store.put({
        tag: p.tag,
        value: null,
        unit: unitForTag(p.tag),
        status,
        reason,
        detail,
        at: this.now(),
      });
    }
  }

  /**
   * The concrete tags that this wildcard pattern has already produced.
   *
   * → Do not guess (contract section 10) — only the ones that were read,
   *   never an invented one
   * → None at all → an empty array (that is "it has never been read", the
   *   first-read case).
   */
  private knownInstancesOf(tagPattern: string): string[] {
    return this.store
      .all()
      .filter((reading) => matchTagPattern(tagPattern, reading.tag))
      .map((reading) => reading.tag);
  }

  /**
   * One round trip failed (a timeout, the transport broke): the tags of
   * that group report stale or error.
   *
   * Contract section 2.1: "ok → stale = this refresh failed, but the last
   * value is kept" — one hiccup of ADB must not make every gauge on the
   * panel disappear (that is the other kind of false number: no number).
   */
  private reportRoundTripFailure(reader: ReaderDef, reason: ReasonCode, detail: string): void {
    for (const p of reader.provides) {
      if (p.tag.includes('*')) {
        // A wildcard tag: mark the known instances (C27 — contract section
        // 2.3: "the refresh stopped → stale")
        // → Do not guess (use the ones that were read) → stale data is no
        //   longer taken for fresh

        for (const tag of this.knownInstancesOf(p.tag)) {
          const status = this.store.failureStatusFor(tag);
          this.store.put({
            tag,
            value: null,
            unit: unitForTag(tag),
            status,
            reason,
            detail,
            at: this.now(),
          });
        }
        continue;
      }
      const status = this.store.failureStatusFor(p.tag);
      this.store.put({
        tag: p.tag,
        value: null,
        unit: unitForTag(p.tag),
        status,
        reason,
        detail,
        at: this.now(),
      });
    }
  }
}
