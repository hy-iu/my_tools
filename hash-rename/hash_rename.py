#!/usr/bin/env python3
"""Local hash-based file renaming workbench.

The server is deliberately implemented with Python's standard library.  It
keeps the dangerous part of the workflow explicit: scan, choose names,
preview a plan, then execute an atomic rename transaction.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
HISTORY_PATH = APP_ROOT / "history.jsonl"
CHUNK_SIZE = 1024 * 1024
INVALID_WINDOWS_NAME_CHARS = set('<>:"/\\|?*')
WINDOWS_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def norm_path(path: Path) -> str:
    """Return a comparison key that follows Windows case-insensitive paths."""
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def hash_file(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as stream:
        while True:
            block = stream.read(CHUNK_SIZE)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def validate_filename(name: Any) -> str:
    """Validate a Windows leaf filename while preserving meaningful spaces."""
    if not isinstance(name, str) or not name or not name.strip():
        raise ValueError("自定义名称不能为空")
    if name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("自定义名称必须是文件名，不能包含文件夹路径")
    if name.endswith((" ", ".")):
        raise ValueError("Windows 文件名不能以空格或句点结尾")
    if any(character in INVALID_WINDOWS_NAME_CHARS or ord(character) < 32 for character in name):
        raise ValueError("自定义名称包含 Windows 不允许的字符")
    if name.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES:
        raise ValueError("自定义名称使用了 Windows 保留名称")
    return name


@dataclass
class ScannedFile:
    file_id: str
    root: str
    path: str
    relative: str
    name: str
    size: int
    modified: float
    digest: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.file_id,
            "root": self.root,
            "path": self.path,
            "relative": self.relative,
            "name": self.name,
            "size": self.size,
            "modified": self.modified,
            "digest": self.digest,
        }


@dataclass
class Group:
    group_id: str
    digest: str
    size: int
    files: list[ScannedFile]

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.group_id,
            "digest": self.digest,
            "size": self.size,
            "files": [item.as_dict() for item in self.files],
        }


@dataclass
class Session:
    session_id: str
    roots: list[str]
    groups: list[Group]
    files: dict[str, ScannedFile]
    created: str
    algorithm: str


@dataclass
class Job:
    job_id: str
    status: str = "queued"
    progress: dict[str, Any] = field(default_factory=dict)
    session_id: str | None = None
    error: str | None = None


@dataclass
class Operation:
    source_id: str
    source: str
    destination: str
    donor_id: str
    digest: str
    conflict: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "source": self.source,
            "destination": self.destination,
            "donor_id": self.donor_id,
            "digest": self.digest,
            "conflict": self.conflict,
        }


class State:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.jobs: dict[str, Job] = {}
        self.sessions: dict[str, Session] = {}
        self.plans: dict[str, tuple[list[Operation], str]] = {}


STATE = State()


def enumerate_files(roots: list[Path], progress: dict[str, Any], lock: threading.RLock) -> list[tuple[str, Path, str, os.stat_result]]:
    found: list[tuple[str, Path, str, os.stat_result]] = []
    seen: set[str] = set()
    for root in roots:
        root_label = os.fspath(root)
        for current, dirnames, filenames in os.walk(root, followlinks=False):
            # Do not recurse into directory symlinks. A scan should never walk
            # outside the roots the user explicitly supplied.
            dirnames[:] = [name for name in dirnames if not (Path(current) / name).is_symlink()]
            for filename in filenames:
                path = Path(current) / filename
                # A file symlink/reparse point could lead outside a selected
                # root just as a directory symlink could. Never rename it.
                if path.is_symlink():
                    continue
                try:
                    info = path.stat()
                except OSError:
                    with lock:
                        progress["errors"] = progress.get("errors", 0) + 1
                    continue
                if not path.is_file():
                    continue
                key = norm_path(path)
                if key in seen:
                    continue
                seen.add(key)
                try:
                    relative = os.fspath(path.relative_to(root))
                except ValueError:
                    relative = path.name
                found.append((root_label, path, relative, info))
                with lock:
                    progress["files_seen"] = len(found)
                    progress["bytes_seen"] = progress.get("bytes_seen", 0) + info.st_size
    return found


def run_scan(job: Job, root_strings: list[str], algorithm: str, workers: int) -> None:
    try:
        roots: list[Path] = []
        for raw in root_strings:
            path = Path(raw).expanduser()
            if not path.exists() or not path.is_dir():
                raise ValueError(f"不是有效文件夹: {raw}")
            roots.append(path.resolve())
        with STATE.lock:
            job.status = "running"
            job.progress = {
                "phase": "enumerating",
                "files_seen": 0,
                "bytes_seen": 0,
                "hash_candidates": 0,
                "hashed": 0,
                "errors": 0,
            }
        entries = enumerate_files(roots, job.progress, STATE.lock)
        by_size: dict[int, list[tuple[str, Path, str, os.stat_result]]] = {}
        for item in entries:
            by_size.setdefault(item[3].st_size, []).append(item)
        candidates = [item for items in by_size.values() if len(items) > 1 for item in items]
        with STATE.lock:
            job.progress["phase"] = "hashing"
            job.progress["hash_candidates"] = len(candidates)
        hashed: list[tuple[str, Path, str, os.stat_result, str]] = []

        def one(item: tuple[str, Path, str, os.stat_result]) -> tuple[tuple[str, Path, str, os.stat_result], str]:
            return item, hash_file(item[1], algorithm)

        # A modest worker count keeps several hard disks from thrashing. The
        # user can lower it for a busy machine.
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = [pool.submit(one, item) for item in candidates]
            for future in as_completed(futures):
                item, digest = future.result()
                hashed.append((*item, digest))
                with STATE.lock:
                    job.progress["hashed"] += 1
        digest_map: dict[str, list[tuple[str, Path, str, os.stat_result, str]]] = {}
        for item in hashed:
            digest_map.setdefault(item[4], []).append(item)
        groups: list[Group] = []
        files: dict[str, ScannedFile] = {}
        next_id = 1
        for digest, items in sorted(digest_map.items()):
            if len(items) < 2:
                continue
            scanned: list[ScannedFile] = []
            for root, path, relative, info, _ in sorted(items, key=lambda x: norm_path(x[1])):
                file_id = f"f{next_id}"
                next_id += 1
                item = ScannedFile(file_id, root, os.fspath(path), relative, path.name, info.st_size, info.st_mtime, digest)
                scanned.append(item)
                files[file_id] = item
            groups.append(Group(f"g{len(groups) + 1}", digest, items[0][3].st_size, scanned))
        session_id = uuid.uuid4().hex
        session = Session(session_id, [os.fspath(root) for root in roots], groups, files, now_iso(), algorithm)
        with STATE.lock:
            STATE.sessions[session_id] = session
            job.session_id = session_id
            job.status = "done"
            job.progress["phase"] = "done"
            job.progress["groups"] = len(groups)
            job.progress["duplicate_files"] = sum(len(group.files) for group in groups)
    except Exception as exc:  # surface errors in the UI instead of killing the worker
        with STATE.lock:
            job.status = "error"
            job.error = f"{type(exc).__name__}: {exc}"
            job.progress["phase"] = "error"


def build_plan(session: Session, choices: list[dict[str, Any]]) -> list[Operation]:
    groups = {group.group_id: group for group in session.groups}
    operations: list[Operation] = []
    source_keys: set[str] = set()
    for choice in choices:
        group = groups.get(str(choice.get("group_id")))
        if group is None:
            raise ValueError(f"找不到哈希组: {choice.get('group_id')}")
        custom_name = choice.get("custom_name")
        use_custom_name = bool(choice.get("use_custom_name"))
        donor_id = str(choice.get("donor_id"))
        if use_custom_name:
            target_name = validate_filename(custom_name)
            donor_id = "__custom__"
        else:
            donor = next((item for item in group.files if item.file_id == donor_id), None)
            if donor is None:
                raise ValueError(f"哈希组 {group.group_id} 的名称来源无效")
            target_name = donor.name
        target_ids = choice.get("target_ids", [])
        if not isinstance(target_ids, list):
            raise ValueError("target_ids 必须是数组")
        for target_id in target_ids:
            target = next((item for item in group.files if item.file_id == str(target_id)), None)
            if target is None:
                raise ValueError(f"哈希组 {group.group_id} 的目标文件无效")
            if donor_id != "__custom__" and target.file_id == donor_id:
                continue
            # The name is already exactly right. It should not become a fake
            # conflict merely because the destination is the source itself.
            if target.name == target_name:
                continue
            source_key = norm_path(Path(target.path))
            if source_key in source_keys:
                raise ValueError(f"同一个文件被重复选择: {target.path}")
            source_keys.add(source_key)
            destination = os.fspath(Path(target.path).with_name(target_name))
            operations.append(Operation(target.file_id, target.path, destination, donor_id, group.digest))
    source_set = {norm_path(Path(operation.source)) for operation in operations}
    by_destination: dict[str, list[Operation]] = {}
    for operation in operations:
        destination_key = norm_path(Path(operation.destination))
        by_destination.setdefault(destination_key, []).append(operation)
    for destination_key, items in by_destination.items():
        if len(items) > 1:
            for operation in items:
                operation.conflict = "同一目录的多个目标会得到同一个文件名"
        for operation in items:
            if Path(operation.destination).exists() and destination_key not in source_set:
                operation.conflict = "目标文件名已存在"
            elif Path(operation.destination).exists() and destination_key in source_set:
            # The destination is another selected source and will be staged;
            # this is safe and is handled by the two-phase executor.
                pass
    return operations


def verify_and_execute(operations: list[Operation], algorithm: str = "sha256", record: bool = True) -> dict[str, Any]:
    if not operations:
        raise ValueError("计划中没有可执行的重命名")
    conflicts = [operation for operation in operations if operation.conflict]
    if conflicts:
        raise ValueError("计划包含冲突，请先处理: " + "; ".join(f"{Path(item.source).name}: {item.conflict}" for item in conflicts[:5]))
    source_keys = {norm_path(Path(item.source)) for item in operations}
    for operation in operations:
        source = Path(operation.source)
        destination = Path(operation.destination)
        if not source.is_file():
            raise FileNotFoundError(f"源文件不存在: {source}")
        if hash_file(source, algorithm) != operation.digest:
            raise ValueError(f"源文件内容已变化，拒绝改名: {source}")
        if destination.exists() and norm_path(destination) not in source_keys:
            raise FileExistsError(f"目标文件已存在: {destination}")
    staged: list[tuple[Operation, Path]] = []
    completed: list[tuple[Operation, Path]] = []
    try:
        for operation in operations:
            source = Path(operation.source)
            temporary = source.with_name(f".hash-rename-{uuid.uuid4().hex}.tmp")
            os.rename(source, temporary)
            staged.append((operation, temporary))
        for operation, temporary in staged:
            destination = Path(operation.destination)
            # On Windows os.rename refuses an existing destination. This is
            # intentional: an external program must never turn a rename race
            # into an overwrite after our preflight check.
            if destination.exists():
                raise FileExistsError(f"执行时目标文件出现: {destination}")
            os.rename(temporary, destination)
            completed.append((operation, destination))
    except Exception:
        # Best-effort rollback: restore completed destinations first, then
        # restore any sources that were only staged.
        for operation, destination in reversed(completed):
            temporary = Path(operation.source).with_name(f".hash-rename-rollback-{uuid.uuid4().hex}.tmp")
            try:
                os.rename(destination, temporary)
                os.rename(temporary, operation.source)
            except OSError:
                pass
        for operation, temporary in reversed(staged):
            if temporary.exists():
                try:
                    os.rename(temporary, operation.source)
                except OSError:
                    pass
        raise
    transaction = {
        "id": uuid.uuid4().hex,
        "created": now_iso(),
        "status": "executed",
        "algorithm": algorithm,
        "operations": [operation.as_dict() for operation in operations],
    }
    if record:
        with HISTORY_PATH.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(transaction, ensure_ascii=False) + "\n")
    return transaction


def read_history() -> list[dict[str, Any]]:
    if not HISTORY_PATH.exists():
        return []
    result: list[dict[str, Any]] = []
    for line in HISTORY_PATH.read_text(encoding="utf-8").splitlines():
        try:
            item = json.loads(line)
            if item.get("status") in {"executed", "undone"}:
                result.append(item)
        except json.JSONDecodeError:
            continue
    return result


def undo_transaction(transaction_id: str) -> dict[str, Any]:
    history = read_history()
    latest: dict[str, dict[str, Any]] = {}
    for item in history:
        latest[str(item.get("id"))] = item
    transaction = latest.get(transaction_id)
    if transaction is not None and transaction.get("status") != "executed":
        transaction = None
    if transaction is None:
        raise ValueError("找不到可撤销的事务，或它已经撤销")
    reverse = [Operation(str(index), item["destination"], item["source"], item.get("donor_id", ""), item["digest"]) for index, item in enumerate(transaction["operations"])]
    # The reverse operation's digest is still the same content hash.
    result = verify_and_execute(reverse, str(transaction.get("algorithm", "sha256")), record=False)
    with HISTORY_PATH.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"id": transaction_id, "created": now_iso(), "status": "undone", "operations": []}, ensure_ascii=False) + "\n")
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "HashRename/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(format % args)

    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            self.serve_file(STATIC_ROOT / "index.html", "text/html; charset=utf-8")
            return
        if path.startswith("/static/"):
            relative = unquote(path.removeprefix("/static/")).replace("/", os.sep)
            candidate = (STATIC_ROOT / relative).resolve()
            if STATIC_ROOT not in candidate.parents:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            content_type = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}.get(candidate.suffix, "application/octet-stream")
            self.serve_file(candidate, content_type)
            return
        parts = [part for part in path.split("/") if part]
        if len(parts) == 3 and parts[:2] == ["api", "job"]:
            with STATE.lock:
                job = STATE.jobs.get(parts[2])
                if job is None:
                    self.send_json({"error": "job 不存在"}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json({"id": job.job_id, "status": job.status, "progress": job.progress, "session_id": job.session_id, "error": job.error})
            return
        if len(parts) == 3 and parts[:2] == ["api", "session"]:
            with STATE.lock:
                session = STATE.sessions.get(parts[2])
                if session is None:
                    self.send_json({"error": "session 不存在"}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json({"id": session.session_id, "roots": session.roots, "created": session.created, "algorithm": session.algorithm, "groups": [group.as_dict() for group in session.groups]})
            return
        if path == "/api/history":
            history = read_history()
            latest: dict[str, dict[str, Any]] = {}
            for item in history:
                latest[item["id"]] = item
            self.send_json([item for item in latest.values() if item.get("status") == "executed"][-50:])
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def serve_file(self, path: Path, content_type: str) -> None:
        try:
            data = path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 10 * 1024 * 1024:
            raise ValueError("请求过大")
        raw = self.rfile.read(length)
        payload = json.loads(raw.decode("utf-8")) if raw else {}
        if not isinstance(payload, dict):
            raise ValueError("请求必须是 JSON 对象")
        return payload

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self.read_json()
            if self.path == "/api/scan":
                roots = payload.get("roots")
                if not isinstance(roots, list) or not roots:
                    raise ValueError("至少提供一个文件夹")
                algorithm = str(payload.get("algorithm", "sha256")).lower()
                if algorithm not in {"sha256", "blake2b", "md5"}:
                    raise ValueError("不支持的哈希算法")
                workers = min(16, max(1, int(payload.get("workers", 4))))
                job = Job(uuid.uuid4().hex)
                with STATE.lock:
                    STATE.jobs[job.job_id] = job
                thread = threading.Thread(target=run_scan, args=(job, [str(item) for item in roots], algorithm, workers), daemon=True)
                thread.start()
                self.send_json({"job_id": job.job_id})
                return
            if self.path in {"/api/validate", "/api/plan"}:
                session_id = str(payload.get("session_id"))
                with STATE.lock:
                    session = STATE.sessions.get(session_id)
                if session is None:
                    raise ValueError("session 不存在")
                operations = build_plan(session, payload.get("choices", []))
                if self.path == "/api/validate":
                    self.send_json({"operations": [operation.as_dict() for operation in operations], "conflicts": sum(bool(operation.conflict) for operation in operations)})
                    return
                plan_id = uuid.uuid4().hex
                with STATE.lock:
                    STATE.plans[plan_id] = (operations, session.algorithm)
                self.send_json({"plan_id": plan_id, "operations": [operation.as_dict() for operation in operations], "conflicts": sum(bool(operation.conflict) for operation in operations)})
                return
            if self.path == "/api/execute":
                plan_id = str(payload.get("plan_id"))
                with STATE.lock:
                    plan = STATE.plans.get(plan_id)
                if plan is None:
                    raise ValueError("plan 不存在或已过期")
                operations, algorithm = plan
                transaction = verify_and_execute(operations, algorithm)
                self.send_json(transaction)
                return
            if self.path == "/api/undo":
                transaction = undo_transaction(str(payload.get("transaction_id")))
                self.send_json(transaction)
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)


def main() -> None:
    parser = argparse.ArgumentParser(description="Hash Rename local review UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Hash Rename running at http://{args.host}:{args.port}/")
    print("按 Ctrl+C 停止；默认只监听本机。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
