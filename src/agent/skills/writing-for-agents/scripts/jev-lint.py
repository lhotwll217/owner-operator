#!/usr/bin/env python3
"""Lint an agent-facing document with jev's wfa-para and wfa-doc schemas.

Usage: jev-lint.py <document.md> [--threshold 0.4]
Prints per-paragraph flags at or above the threshold, then whole-document scores.
"""
import json, os, subprocess, sys, tempfile

# Node's default IPv6/IPv4 race times out against the jev API on this machine; a longer
# per-family attempt window connects (curl works without it).
ENV = {**os.environ, "NODE_OPTIONS": (os.environ.get("NODE_OPTIONS", "") + " --network-family-autoselection-attempt-timeout=2000").strip()}

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    path = args[0]
    threshold = float(args[args.index("--threshold") + 1]) if "--threshold" in args else 0.4
    guidance = "\n\n".join(open(os.path.join(HERE, f)).read() for f in ("SKILL.md", "SKILL-MECHANICS.md"))
    doc = open(path).read()
    body = doc.split("---", 2)[2] if doc.startswith("---") else doc
    paras = [p for p in body.strip().split("\n\n") if p.strip()]
    with tempfile.TemporaryDirectory() as tmp:
        rows = os.path.join(tmp, "paras.jsonl")
        with open(rows, "w") as f:
            for i, p in enumerate(paras, 1):
                f.write(json.dumps({"id": f"p{i}", "state": {"guidance": guidance, "document": doc, "excerpt": p}}) + "\n")
        state = os.path.join(tmp, "doc.json")
        json.dump({"guidance": guidance, "document": doc}, open(state, "w"))
        para_out = subprocess.run(["jev", "batch", "--input", rows, "--schema", "wfa-para", "--compact", "--no-summary"],
                                  capture_output=True, text=True, check=True, env=ENV).stdout
        doc_out = subprocess.run(["jev", "run", "--state", "@" + state, "--schema", "wfa-doc", "--compact"],
                                 capture_output=True, text=True, check=True, env=ENV).stdout
    for line in para_out.splitlines():
        r = json.loads(line)
        n = int(r["id"][1:])
        flags = {k: round(v["noul"], 2) for k, v in r["answers"].items() if v["noul"] >= threshold}
        print(f'{r["id"]} {flags or "clean"} | {paras[n - 1][:70]!r}')
    answers = json.loads(doc_out)
    answers = answers.get("answers", answers)
    print("DOC", {k: round(v["noul"], 2) for k, v in answers.items()})

if __name__ == "__main__":
    main()
