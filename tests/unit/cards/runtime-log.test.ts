import { describe, it, expect } from 'vitest';
import { CardRuntimeLog } from '../../../src/main/cards/runtime-log';

/**
 * The runtime log of the card.
 *
 * The most important one: a CSP violation has to be filed under **the right
 * card**:
 *
 * Contract §6.1 promises that "the agent can see "this card tried to reach
 * the network"". But a violation carries an **instance id**
 * (`cockpit://card/<instance id>/…`) while the log is stored **per card id**
 * (`get_card_runtime_log(cardId)`) — so there has to be a mapping from the
 * instance to the card in between.
 *
 * **What cannot be filed is not recorded**: a log under the wrong card is worse
 * than no log (it sends the agent to inspect a card that **did nothing
 * wrong**).
 */
describe('the runtime log of the card', () => {
  it('appending and reading (in the order of the time)', () => {
    const log = new CardRuntimeLog({ now: () => 1000 });
    log.append('cpu-usage', { source: 'card', level: 'info', message: 'the first line' });
    log.append('cpu-usage', { source: 'host', level: 'warn', message: 'the second line' });
    const entries = log.read('cpu-usage');
    expect(entries.map((e) => e.message)).toEqual(['the first line', 'the second line']);
    expect(entries[0]?.at).toBe(1000);
  });

  it('the cards cannot see each other', () => {
    const log = new CardRuntimeLog();
    log.append('card-a', { source: 'card', level: 'info', message: 'the matter of A' });
    expect(log.read('card-b')).toEqual([]);
  });

  it('a CSP violation is filed under **the right card**', () => {
    const log = new CardRuntimeLog();
    log.bind('inst-1', 'cpu-usage');
    const cardId = log.attributeCspViolation({
      message: "Refused to connect to 'https://example.com/'",
      sourceUrl: 'cockpit://card/inst-1/index.html',
    });
    expect(cardId).toBe('cpu-usage');
    const entries = log.read('cpu-usage');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('csp');
    expect(entries[0]?.level).toBe('error');
    expect(entries[0]?.message).toMatch(/example\.com/);
  });

  it('**what cannot be filed is not recorded** (an unknown instance / an address that is not a card)', () => {
    const log = new CardRuntimeLog();
    log.bind('inst-1', 'cpu-usage');
    expect(log.attributeCspViolation({ message: 'x', sourceUrl: 'cockpit://card/inst-9/x.js' })).toBeNull();
    expect(log.attributeCspViolation({ message: 'x', sourceUrl: 'https://example.com/a.js' })).toBeNull();
    expect(log.read('cpu-usage')).toEqual([]);
  });

  it('the number of entries has a limit (beyond it the oldest is dropped)', () => {
    const log = new CardRuntimeLog({ limitPerCard: 3 });
    for (let i = 0; i < 5; i += 1) {
      log.append('cpu-usage', { source: 'card', level: 'info', message: `entry ${i}` });
    }
    const entries = log.read('cpu-usage');
    expect(entries).toHaveLength(3);
    expect(entries[0]?.message).toBe('entry 2');
  });
});
