"""Portable real-tools CLI acceptance; evidence stays outside product sources."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import sqlite3
import shutil
import subprocess
import sys
import time

NOTICE = "By the way, these projects and files cannot be shown with the installed tools."
MEDIA = "application/x-dinkster-workflow+json"


def seed(root: Path) -> None:
    from dinkster_assets import AssetRef, LibraryStore, digest_bytes
    from dinkster_library import LibraryClient

    root.mkdir()
    library = root / "dinkster-library"
    store = LibraryStore(library / "library.sqlite")
    owned = []
    try:
        for project, count in (("beta", 3), ("default", 1)):
            for index in range(count):
                name = f"{project}-workflow-{index}"
                record = store.create("local", name, digest_bytes(name.encode()), MEDIA)
                owned.append((project, record.id))
                asset = AssetRef(digest_bytes(f"{project}-image-{index}".encode()), f"{project}-{index}.png", index + 3, "image/png")
                store.record_asset("local", asset, original_name=asset.name, kind="media/image", origin={"kind": "upload"}, project=project, created=index + 1)
        hidden = store.create("other-scope", "Other scope", digest_bytes(b"private"), MEDIA)
        store.record_asset("other-scope", AssetRef(digest_bytes(b"private-image"), "private.png", 13, "image/png"), original_name="private.png", kind="media/image", origin={"kind": "upload"}, project="beta")
    finally:
        store.close()
    with LibraryClient(library) as helper:
        helper.call("projects.register", id="beta", name="Beta project")
        helper.call("projects.register", id="zebra", name="Zebra project")
        for project, identifier in owned:
            helper.call("workflows.record", scope="local", id=identifier, project=project, revision=0)
        helper.call("workflows.record", scope="other-scope", id=hidden.id, project="beta", revision=0)
    (root / "project.json").write_text("legacy configuration remains unchanged", encoding="utf-8")


def alive(pid: int) -> bool:
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            return False
        try:
            kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            return kernel.WaitForSingleObject(handle, 0) == 0x102
        finally:
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def schema(path: Path) -> list:
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        return db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()


def run(args: argparse.Namespace) -> None:
    evidence = args.evidence.resolve()
    evidence.mkdir()
    root = evidence / "installation"
    pidfile = evidence / "helper-pids.jsonl"
    auditfile = evidence / "subprocesses.jsonl"
    environment = {key: value for key, value in os.environ.items() if not key.startswith(("DINKSTER_", "PYTHON"))}
    environment.update(CUDA_VISIBLE_DEVICES="", DINKSTER_ACCELERATOR="cpu")
    probe = (
        "import os,runpy; from pathlib import Path; "
        f"p=Path({str(pidfile)!r}); "
        "p.open('a').write(str(os.getpid())+'\\n'); "
        "runpy.run_module('dinkster_library',run_name='__main__')"
    )
    environment["DINKSTER_LIBRARY_COMMAND"] = json.dumps([str(args.tools_python), "-I", "-c", probe])
    audit = (
        "import ctypes,json,runpy,sys; from pathlib import Path\n"
        "def observe(event,args):\n"
        " if event=='subprocess.Popen':\n"
        "  command=args[1]\n"
        "  if isinstance(command,str):\n"
        "   split=ctypes.windll.shell32.CommandLineToArgvW\n"
        "   split.argtypes=[ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_int)]\n"
        "   split.restype=ctypes.POINTER(ctypes.c_wchar_p)\n"
        "   count=ctypes.c_int()\n"
        "   pointer=split(command,ctypes.byref(count))\n"
        "   if not pointer: raise ctypes.WinError()\n"
        "   try: command=list(pointer[:count.value])\n"
        "   finally:\n"
        "    free=ctypes.windll.kernel32.LocalFree\n"
        "    free.argtypes=[ctypes.c_void_p]; free.restype=ctypes.c_void_p\n"
        "    free(pointer)\n"
        "  row={'executable':Path(args[0] or command[0]).name,'engine':any('dinkster_engine' in str(s) or 'dinkster.engine' in str(s) for s in command)}\n"
        f"  Path({str(auditfile)!r}).open('a').write(json.dumps(row)+'\\n')\n"
        "sys.addaudithook(observe)\n"
        "runpy.run_module('dinkster_supervisor.environment',run_name='__main__')\n"
    )
    results = []

    def query(kind: str, *, project: str = "default", cursor: str | None = None, library: Path | None = None, error: bool = False) -> dict:
        env = {**environment, "DINKSTER_LIBRARY_ROOT": str(library or root / "dinkster-library")}
        command = [str(args.tools_python), "-I", "-c", audit, "--root", str(root), "library-list", kind, "--project", project, "--limit", "2", "--json"]
        if cursor is not None:
            command.append("--cursor=" + cursor)
        start = time.monotonic()
        completed = subprocess.run(command, env=env, text=True, capture_output=True, timeout=90)
        row = json.loads(completed.stdout)
        assert completed.returncode == (1 if error else 0), (completed.returncode, row, completed.stderr)
        assert row["operation"] == "library-list" and row["root"] == str(root)
        pids = [] if not pidfile.exists() else [int(p) for p in pidfile.read_text().splitlines()]
        assert all(not alive(pid) for pid in pids), pids
        results.append({"kind": kind, "project": project, "seconds": time.monotonic() - start, "result": row, "helperPids": pids})
        (evidence / "results.json").write_text(json.dumps({"platform": platform.platform(), "toolsPython": str(args.tools_python), "cases": results}, indent=2), encoding="utf-8")
        return row

    for kind, key in (("projects", "items"), ("workflows", "records"), ("assets", "assets")):
        row = query(kind)
        assert row["library"] == {"kind": kind, key: [], "cursor": None}
    assert not root.exists()
    if args.fixture:
        shutil.copytree(args.fixture, root)
    else:
        seeded = subprocess.run([str(args.seed_python), "-I", str(Path(__file__).resolve()), "seed", str(root)], env=environment, capture_output=True, text=True, timeout=90)
        (evidence / "seed.log").write_text(seeded.stdout + seeded.stderr, encoding="utf-8")
        assert seeded.returncode == 0, seeded.stderr
    library = root / "dinkster-library"
    database = library / "library.sqlite"
    before_schema = schema(database)
    before_digest = hashlib.sha256(database.read_bytes()).hexdigest()
    first = query("projects")["library"]
    assert [row["id"] for row in first["items"]] == ["beta", "default"]
    last = query("projects", cursor=first["cursor"])["library"]
    assert [row["id"] for row in last["items"]] == ["zebra"] and last["cursor"] is None
    if args.complete:
        for kind, key, names in (("workflows", "records", {f"beta-workflow-{i}" for i in range(3)}), ("assets", "assets", {f"beta-{i}.png" for i in range(3)})):
            first = query(kind, project="beta")["library"]
            assert len(first[key]) == 2 and isinstance(first["cursor"], str)
            last = query(kind, project="beta", cursor=first["cursor"])["library"]
            assert len(last[key]) == 1 and last["cursor"] is None
            rows = first[key] + last[key]
            assert {row["name"] if kind == "workflows" else row["asset"]["name"] for row in rows} == names
            default = query(kind)["library"][key]
            assert len(default) == 1
    assert schema(database) == before_schema
    assert hashlib.sha256(database.read_bytes()).hexdigest() == before_digest
    assert (root / "project.json").read_text() == "legacy configuration remains unchanged"
    assert sorted(p.name for p in root.iterdir()) == ["dinkster-library", "project.json"]
    corrupt = evidence / "unreadable-library"
    corrupt.mkdir()
    (corrupt / "records.sqlite").write_bytes(b"not a database")
    refusal = query("projects", library=corrupt, error=True)
    assert refusal["error"] == NOTICE and "library" not in refusal
    audits = [json.loads(line) for line in auditfile.read_text().splitlines()]
    assert audits and not any(row["engine"] for row in audits)
    print(f"PASS: {len(results)} real CLI cases; all observed helpers exited; no supervisor engine launch; library.sqlite bytes/schema and environment unchanged. Complete browse={args.complete}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "seed":
        seed(Path(sys.argv[2]))
    else:
        parser = argparse.ArgumentParser()
        parser.add_argument("--tools-python", type=Path, required=True)
        parser.add_argument("--evidence", type=Path, required=True)
        fixture = parser.add_mutually_exclusive_group(required=True)
        fixture.add_argument("--seed-python", type=Path)
        fixture.add_argument("--fixture", type=Path)
        parser.add_argument("--complete", action="store_true")
        run(parser.parse_args())
