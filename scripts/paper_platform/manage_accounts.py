#!/usr/bin/env python3
"""Issue private passwords and administer project membership offline."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from apps.paper_workspace.password_gate import accounts


def stage_file(path: Path, content: bytes) -> Path:
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        staged = Path(handle.name)
        try:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            staged.unlink(missing_ok=True)
            raise
    return staged


def save_registry(path: Path, data: dict, secret_path: Path | None = None,
                  secret: str | None = None) -> None:
    accounts.validate_registry(data)
    temporary = stage_file(path, (json.dumps(data, indent=2) + "\n").encode())
    staged_secret = previous = None
    try:
        if secret_path is not None:
            if secret_path.exists() or secret_path.is_symlink():
                raise FileExistsError(secret_path)
            secret_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            staged_secret = stage_file(secret_path, secret.encode())
            if path.exists():
                previous = stage_file(path, path.read_bytes())
        os.replace(temporary, path)
        if staged_secret is not None:
            try:
                # A hard link publishes a complete 0600 file without replacing
                # an existing secret, even if another process created it.
                os.link(staged_secret, secret_path)
            except OSError:
                if previous is None:
                    path.unlink()
                else:
                    os.replace(previous, path)
                raise
    finally:
        for staged in (temporary, staged_secret, previous):
            if staged is not None:
                staged.unlink(missing_ok=True)


def update_registry(parser, args) -> None:
    path = args.registry
    if path.is_symlink():
        parser.error("registry must not be a symlink")
    data = accounts.validate_registry(json.loads(path.read_text())) if path.exists() else {"users": {}, "projects": {}}
    name = args.user
    if args.command == "issue-user":
        if name in data["users"] and not args.rotate:
            parser.error("user exists; use --rotate deliberately")
        if args.secret_output.resolve() in {path.resolve(), path.with_name(f".{path.name}.lock").resolve()}:
            parser.error("secret output must differ from registry and lock paths")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?", args.domain):
            parser.error("invalid login domain")
        password = secrets.token_urlsafe(24)
        data["users"][name] = {"password_hash": accounts.password_hash(password)}
        save_registry(path, data, args.secret_output,
                      f"주소: https://{args.domain}/{name}\n개인 공간: {name}\n암호: {password}\n")
        return

    if name not in data["users"]:
        parser.error("unknown user")
    if args.command == "disable-user":
        data["users"][name]["disabled"] = True
    elif args.command == "revoke":
        data["projects"].get(args.project, {}).get("members", {}).pop(name, None)
    else:
        if not accounts.SLUG.fullmatch(args.project) or not accounts.SLUG.fullmatch(args.backup_id):
            parser.error("invalid project identity")
        project = data["projects"].setdefault(args.project, {"backup_id": args.backup_id, "members": {}})
        if project["backup_id"] != args.backup_id:
            parser.error("backup identity cannot be changed")
        project["members"][name] = args.role
    save_registry(path, data)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--domain", default=os.environ.get("PAPER_DOMAIN", "paper.glowme.kr"))
    sub = parser.add_subparsers(dest="command", required=True)
    issue = sub.add_parser("issue-user")
    issue.add_argument("--user", required=True)
    issue.add_argument("--rotate", action="store_true", help="Replace an existing password and revoke its sessions")
    issue.add_argument("--secret-output", required=True, type=Path)
    issue.add_argument("--domain", default=argparse.SUPPRESS)
    grant = sub.add_parser("grant")
    grant.add_argument("--user", required=True)
    grant.add_argument("--project", required=True)
    grant.add_argument("--backup-id", required=True)
    grant.add_argument("--role", choices=accounts.ROLES, required=True)
    revoke = sub.add_parser("revoke")
    revoke.add_argument("--user", required=True)
    revoke.add_argument("--project", required=True)
    disable = sub.add_parser("disable-user")
    disable.add_argument("--user", required=True)
    args = parser.parse_args()
    if not accounts.SLUG.fullmatch(args.user):
        parser.error("invalid user name")
    path = args.registry
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = path.with_name(f".{path.name}.lock")
        with os.fdopen(os.open(lock, os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600), "w") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            update_registry(parser, args)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"{args.command}: {args.user}; private registry updated")


if __name__ == "__main__":
    main()
