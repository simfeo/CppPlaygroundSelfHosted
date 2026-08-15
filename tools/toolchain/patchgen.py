"""Edits an llvm-project file and writes the resulting diff to patches/.

Used while porting LLVM to wasm32-wasi: WASI lacks a handful of POSIX calls, and
each gap needs a small guarded patch. Generating the patches (rather than
hand-writing them) keeps their context matching the pinned LLVM version.

    python3 patchgen.py <llvm-src> <relative/file.cpp> <patch-name> <<'EOF'
    old text
    ---
    new text
    EOF
"""

import os
import subprocess
import sys


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    src_root, rel_path, patch_name = sys.argv[1:]

    old, _, new = sys.stdin.read().partition("\n---\n")
    old, new = old.strip("\n"), new.strip("\n")

    path = os.path.join(src_root, rel_path)
    with open(path, encoding="utf-8") as handle:
        text = handle.read()

    if text.count(old) != 1:
        sys.exit(f"pattern occurs {text.count(old)} times in {rel_path}, need exactly 1")

    original = path + ".orig"
    with open(original, "w", encoding="utf-8") as handle:
        handle.write(text)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text.replace(old, new, 1))

    diff = subprocess.run(["diff", "-u", original, path],
                          capture_output=True, text=True).stdout.splitlines(True)
    diff[0] = f"--- a/{rel_path}\n"
    diff[1] = f"+++ b/{rel_path}\n"
    os.remove(original)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patches", patch_name)
    with open(out, "w", encoding="utf-8", newline="\n") as handle:
        handle.writelines(diff)
    print(f"wrote {out} ({len(diff)} lines)")


if __name__ == "__main__":
    main()
