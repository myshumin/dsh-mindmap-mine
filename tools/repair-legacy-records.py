#!/usr/bin/env python3
"""Rewrite dsh-mindmap-mine legacy `mindmap/update` session events into the
harness-sanctioned plugin-record shape (`plugin:<ns>/<name>` + ignorable:true).

Safe by construction: decompress -> verify -> rewrite -> recompress -> re-verify
-> atomic replace, with a byte-identical backup next to the original.
"""
import json
import os
import shutil
import subprocess
import sys
import time

NEW_TYPE = "plugin:dsh-mindmap-mine/map"
LEGACY_TYPE = "mindmap/update"


def run(*args):
    return subprocess.run(args, check=True, capture_output=True)


def read_events(path):
    tmp = path + ".tmp.jsonl"
    run("zstd", "-d", "-f", "-q", path, "-o", tmp)
    with open(tmp, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()
    os.unlink(tmp)
    return [json.loads(l) for l in lines if l.strip()]


def check(events, subject):
    """Replicate the harness restore gate: known types, or ignorable plugin records."""
    assert events and events[0].get("type") == "session", f"{subject}: missing header"
    for e in events[1:]:
        t = e.get("type")
        assert isinstance(t, str) and t, f"{subject}: event without a type"
        assert isinstance(e.get("seq"), int), f"{subject}: event without seq"
        assert "data" in e, f"{subject}: {t} seq {e.get('seq')} without data"
        if t.startswith("plugin:"):
            assert e.get("ignorable") is True, f"{subject}: {t} must carry ignorable=true"
        if t == LEGACY_TYPE:
            raise AssertionError(f"{subject}: legacy {LEGACY_TYPE} still present at seq {e['seq']}")
    seqs = [e["seq"] for e in events[1:]]
    assert seqs == list(range(seqs[0], seqs[0] + len(seqs))), f"{subject}: seq not contiguous"


def repair(path):
    print(f"== {path}")
    events = read_events(path)
    header = events[0]
    assert header.get("type") == "session", "not a session log"
    assert header.get("version") == 4, f"unexpected format version {header.get('version')}"
    legacy = [e for e in events if e.get("type") == LEGACY_TYPE]
    print(f"   events={len(events)} header.id={header['id']} legacy={len(legacy)}")
    if not legacy:
        print("   nothing to do")
        return False
    for e in legacy:
        print(f"   seq {e['seq']}: {LEGACY_TYPE} -> {NEW_TYPE} (ignorable=true)")
        e_new = {
            "type": NEW_TYPE,
            "seq": e["seq"],
            "time": e["time"],
            "ignorable": True,
            "data": e["data"],
        }
        for k, v in e.items():
            if k not in e_new:
                e_new[k] = v
        e.clear()
        e.update(e_new)
    check(events, path)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{path}.bak-mindmap-{stamp}"
    shutil.copy2(path, backup)
    print(f"   backup: {backup}")

    staged = f"{path}.staged-{stamp}"
    jsonl = staged + ".jsonl"
    with open(jsonl, "w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")
    run("zstd", "-19", "-f", "-q", "--no-progress", jsonl, "-o", staged)
    os.unlink(jsonl)

    # Re-verify the encoded artifact by decoding it again.
    check(read_events(staged), staged)
    os.chmod(staged, 0o600)
    os.replace(staged, path)
    print(f"   wrote {os.path.getsize(path)} bytes; originals verified")
    return True


if __name__ == "__main__":
    changed = 0
    for p in sys.argv[1:]:
        changed += bool(repair(p))
    print(f"repaired {changed} session(s)")
