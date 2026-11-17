# Converts .proto schema text to .ksy specs via protokai.
#
# Request JSON on stdin: {"files": {"name.proto": "syntax = ..."}, "type": "Person" (optional)}
# Response JSON on stdout: {"entry": "person", "files": {"person.ksy": "..."}, "warnings": [...]}
#
# protokai (github.com/nemanjan00/protokai) must be importable: the lab driver
# puts PROTOKAI_PATH on PYTHONPATH. protoc must be on PATH.

import json
import sys
import tempfile
from pathlib import Path

from protokai.compiler import Compiler
from protokai.descriptors import run_protoc


def main() -> int:
    request = json.load(sys.stdin)
    files = request.get("files") or {}
    if not files:
        print("protokai_bridge: no .proto files given", file=sys.stderr)
        return 2
    wanted = request.get("type") or None

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        paths = []
        for name, text in files.items():
            clean = Path(name).name  # no directories: everything lands flat
            (tmp / clean).write_text(text, encoding="utf-8")
            paths.append(tmp / clean)
        try:
            result = run_protoc(paths, proto_paths=[tmp])
            compiler = Compiler(result.descriptor_set)
            output = compiler.compile(result.requested)
        except Exception as exc:  # protoc / protokai errors arrive as text
            print("protokai_bridge: %s" % exc, file=sys.stderr)
            return 1

        entry = None
        if wanted:
            # match the requested message name against declared messages
            for info in compiler.messages.values():
                if info.desc.name == wanted:
                    entry = info.ks_id
                    break
            if entry is None:
                print("protokai_bridge: no top-level message %r in the schema" % wanted,
                      file=sys.stderr)
                return 1
        else:
            # default: first top-level message of the first requested .proto
            first_file = None
            first_msg = None
            for fd in result.descriptor_set.file:
                if fd.name in result.requested and fd.message_type:
                    first_file, first_msg = fd.name, fd.message_type[0].name
                    break
            for info in compiler.messages.values():
                if info.proto_file == first_file and info.desc.name == first_msg:
                    entry = info.ks_id
                    break

    json.dump({
        "entry": entry,
        "files": output.files,
        "warnings": [str(w) for w in output.warnings],
    }, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
