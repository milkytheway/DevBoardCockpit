import { describe, it, expect } from 'vitest';
import {
  pathWarning,
  reportPath,
} from '../../scripts/check-installer-path';

/**
 * **The path of the working tree and the installer.**
 *
 * | Criterion | Why |
 * |---|---|
 * | a plain ASCII path is reported as plain | the ordinary case must not cry wolf |
 * | a path with Chinese characters is reported | the installer fails there (measured 2026-11-22) |
 * | the warning names the path and the characters | the person has to know *what* to change |
 * | the warning says the application is fine | the application reads the profiles and the cards from that path without trouble — only the installer is affected |
 * | the warning says the release is not affected | the published installer is built on a runner with a plain path |
 */
describe('the path of the working tree and the installer', () => {
  it('**a plain ASCII path is reported as plain** ✓', () => {
    const report = reportPath('C:\\work\\DevBoardCockpit');
    expect(report.plainAscii).toBe(true);
    expect(report.offenders).toEqual([]);
    expect(pathWarning(report)).toBe('');
  });

  it('**a path with Chinese characters is reported** ✓ (the installer fails there ✓)', () => {
    const report = reportPath('D:\\3588\\02\u3001RK3588\u5f00\u53d1\u5e73\u53f0\\DevBoardCockpit');
    expect(report.plainAscii).toBe(false);
    expect(report.offenders.length).toBeGreaterThan(0);
  });

  it('**the warning names the path and the characters** ✓ (the person has to know what to change ✓)', () => {
    const warning = pathWarning(reportPath('D:\\3588\\02\u3001RK3588\u5f00\u53d1\u5e73\u53f0\\DevBoardCockpit'));
    expect(warning).toContain('D:\\3588\\02\u3001RK3588\u5f00\u53d1\u5e73\u53f0\\DevBoardCockpit');
    // → The characters are named by their code point ✓ (a Chinese character
    //   cannot be shown reliably in a console ✓).
    expect(warning).toMatch(/U\+[0-9A-F]{4}/);
    expect(warning).toContain('Error writing temporary file');
  });

  it('**the warning says the application itself is fine** ✓ (only the installer is affected ✓)', () => {
    const warning = pathWarning(reportPath('D:\\3588\\02\u3001RK3588\u5f00\u53d1\u5e73\u53f0\\DevBoardCockpit'));
    expect(warning).toContain('the application itself is fine');
  });

  it('**the warning says the published release is not affected** ✓ (the runner path is plain ✓)', () => {
    const warning = pathWarning(reportPath('D:\\3588\\02\u3001RK3588\u5f00\u53d1\u5e73\u53f0\\DevBoardCockpit'));
    expect(warning).toContain('the published release is not affected');
  });
});
