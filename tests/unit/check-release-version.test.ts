import { describe, it, expect } from 'vitest';
import {
  checkReleaseVersion,
  versionOfTag,
} from '../../scripts/check-release-version';

/**
 * The release criterion.
 *
 * | Criterion | Why |
 * |---|---|
 * | the tag and the package name the same version | the name of the installer comes from the package — when they disagree the release says one version and the file carries another |
 * | a manual run (no tag) needs a version of the shape x.y.z | the version ends up in the name of the artefact |
 */
describe('the release version', () => {
  it('**the version a tag names** ✓ (`v0.1.0` → `0.1.0` ✓)', () => {
    expect(versionOfTag('v0.1.0')).toBe('0.1.0');
    expect(versionOfTag('0.1.0')).toBe('0.1.0');
  });

  it('**the tag and the package agree → nothing to say** ✓', () => {
    expect(checkReleaseVersion('0.1.0', 'v0.1.0')).toBeNull();
    expect(checkReleaseVersion('0.1.0', '0.1.0')).toBeNull();
  });

  it('**they disagree → it says which one is which** ✓', () => {
    const problem = checkReleaseVersion('0.1.0', 'v0.2.0');
    expect(problem).toContain('v0.2.0');
    expect(problem).toContain('0.1.0');
  });

  it('**a manual run (no tag) needs a version of the shape x.y.z** ✓', () => {
    expect(checkReleaseVersion('0.1.0', undefined)).toBeNull();
    expect(checkReleaseVersion('0.1.0-beta', undefined)).toContain('x.y.z');
  });
});
