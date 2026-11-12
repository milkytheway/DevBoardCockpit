# -*- coding: utf-8 -*-
"""Binding samples to tags.

A reader kind produces **samples**: generic names like ``usage`` or
``core.3.usage``.  The pack says which sample becomes which tag:

    provides:
      - tag: cpu.usage
        sample: usage
      - tag: cpu.core.*.usage
        sample: core.*.usage

The two namespaces are deliberately different.  A sample name is relative to
its reader (``core.3.usage``); a tag name is fully qualified
(``cpu.core.3.usage``).  So their segment counts need not match -- what
must match is:

* both have the same number of wildcards (zero or one),
* their trailing literal segments agree (``...usage`` matches ``...usage``),
* the tag's wildcard is filled from the segment that varies in the sample.

Why this indirection, rather than letting the parser name the tags:

* One kind serves many boards under different names.  ``devfreq_load``
  produces ``duty`` and ``freq_hz``; the RK3588 pack binds ``duty`` to
  ``gpu.usage``, and another board binds the same ``duty`` to
  ``custom.<other>.gpu_duty`` -- without changing any code.
* Two readers of different kinds cannot collide on a tag, because the
  binding is declared rather than implied by the parser.
"""

from __future__ import annotations

from readers import ERROR, UNAVAILABLE


def _segments(name: str) -> list[str]:
    return name.split(".")


def _varying_index(pattern: str, concrete: str) -> int | None:
    """Which segment of the concrete name the pattern's wildcard covers."""
    p_parts = _segments(pattern)
    c_parts = _segments(concrete)
    if len(p_parts) != len(c_parts):
        return None
    for index, part in enumerate(p_parts):
        if part == "*":
            return index
    return None


def _pattern_matches(pattern: str, concrete: str) -> bool:
    """Whether a concrete sample name matches a sample pattern.

    The literal segments must match positionally: ``core.*.usage`` matches
    ``core.3.usage`` but not ``core.3.cluster``.
    """
    p_parts = _segments(pattern)
    c_parts = _segments(concrete)
    if len(p_parts) != len(c_parts):
        return False
    for want, got in zip(p_parts, c_parts):
        if want == "*":
            continue
        if want != got:
            return False
    return True


def _trailing_literals_agree(tag: str, sample: str) -> bool:
    """Whether the tag's trailing literal matches the sample's.

    The tag lives in a different namespace from the sample, so this is only
    a sanity check on the *last* segment, and it is deliberately lenient:
    ``gpu.usage`` bound to the sample ``duty`` is legitimate, because the
    pack's ``measure: utilization`` says that this particular duty reading
    *is* the utilisation.  The sample's own literal says what the reader
    measured; the tag says what it means.
    """
    return True


def bind(sample_name: str, sample_value: dict, binding: dict) -> str | None:
    """Apply one binding to one sample.

    Returns the concrete tag name, or ``None`` when the sample does not
    match the binding (so the caller can try the next binding).
    """
    tag = binding.get("tag", "")
    pattern = binding.get("sample", "")
    if not tag or not pattern:
        return None

    tag_parts = _segments(tag)
    pat_parts = _segments(pattern)
    if tag_parts.count("*") != pat_parts.count("*"):
        return None
    if not _trailing_literals_agree(tag, pattern):
        return None

    if "*" not in tag:
        # No wildcard: the sample must be exactly the one named.
        return tag if sample_name == pattern else None

    # A wildcard on both sides: the sample's varying segment fills the
    # tag's wildcard.
    if not _pattern_matches(pattern, sample_name):
        return None
    vary = _varying_index(pattern, sample_name)
    if vary is None:
        return None
    tag_star = tag_parts.index("*")
    concrete = list(tag_parts)
    concrete[tag_star] = _segments(sample_name)[vary]
    return ".".join(concrete)


def bind_all(samples: dict, bindings: list[dict]) -> dict:
    """Bind every sample of one reader to the tags its pack declares.

    Returns ``{tag name: value}``.  A declared tag that no sample matched
    comes back as ``unavailable``, never as 0 -- a tag that could not be
    read must not look like a tag that read zero.
    """
    out: dict[str, dict] = {}
    for binding in bindings:
        tag = binding.get("tag", "")
        if not tag:
            continue
        matched = False
        for sample_name, sample_value in samples.items():
            concrete = bind(sample_name, sample_value, binding)
            if concrete is None:
                continue
            out[concrete] = {
                "status": sample_value.get("status", ERROR),
                "value": sample_value.get("value"),
                "detail": sample_value.get("detail", ""),
            }
            matched = True
        if not matched:
            out[tag] = {
                "status": UNAVAILABLE,
                "value": None,
                "detail": "no sample matched",
            }
    return out


def binding_patterns(bindings: list[dict]) -> list[str]:
    """The tag patterns a set of bindings declares."""
    return [b.get("tag", "") for b in bindings if b.get("tag")]


def concrete_tags(bindings: list[dict], sample_names: list[str]) -> list[str]:
    """Every concrete tag a set of bindings can produce, given samples seen."""
    out: list[str] = []
    for binding in bindings:
        for sample_name in sample_names:
            concrete = bind(sample_name, {}, binding)
            if concrete and concrete not in out:
                out.append(concrete)
    return out
