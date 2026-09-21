#!/usr/bin/env python3
"""Issue private passwords and administer project membership offline."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import tempfile

MODULE = Path(__file__).resolve().parents[2] / 'apps/paper_workspace/password_gate/accounts.py'
spec = importlib.util.spec_from_file_location('paper_accounts', MODULE)
accounts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', required=True, type=Path)
    sub = parser.add_subparsers(dest='command', required=True)
    issue = sub.add_parser('issue-user')
    issue.add_argument('--user', required=True)
    issue.add_argument('--rotate', action='store_true', help='Replace an existing password and revoke its sessions')
    issue.add_argument('--secret-output', required=True, type=Path)
    grant = sub.add_parser('grant')
    grant.add_argument('--user', required=True)
    grant.add_argument('--project', required=True)
    grant.add_argument('--backup-id', required=True)
    grant.add_argument('--role', choices=['owner', 'editor', 'viewer'], required=True)
    revoke = sub.add_parser('revoke')
    revoke.add_argument('--user', required=True)
    revoke.add_argument('--project', required=True)
    disable = sub.add_parser('disable-user')
    disable.add_argument('--user', required=True)
    args = parser.parse_args()
    if not accounts.SLUG.fullmatch(args.user): parser.error('invalid user name')
    path = args.registry
    if path.is_symlink(): parser.error('registry must not be a symlink')
    data = json.loads(path.read_text()) if path.exists() else {'users': {}, 'projects': {}}
    if args.command == 'issue-user':
        if args.user in data['users'] and not args.rotate: parser.error('user exists; use --rotate deliberately')
        password = secrets.token_urlsafe(24)
        args.secret_output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(args.secret_output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(f'주소: https://paper.glowme.kr/{args.user}\n개인 공간: {args.user}\n암호: {password}\n')
        data['users'][args.user] = {'password_hash': accounts.password_hash(password)}
    else:
        if args.user not in data['users']: parser.error('unknown user')
        if args.command == 'disable-user': data['users'][args.user]['disabled'] = True
        elif args.command == 'revoke': data['projects'].get(args.project, {}).get('members', {}).pop(args.user, None)
        else:
            if not accounts.SLUG.fullmatch(args.project) or not accounts.SLUG.fullmatch(args.backup_id): parser.error('invalid project identity')
            project = data['projects'].setdefault(args.project, {'backup_id': args.backup_id, 'members': {}})
            if project['backup_id'] != args.backup_id: parser.error('backup identity cannot be changed')
            if any(slug != args.project and p['backup_id'] == args.backup_id for slug, p in data['projects'].items()): parser.error('duplicate backup identity')
            project['members'][args.user] = args.role
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
        json.dump(data, f, indent=2); f.write('\n')
        temporary = Path(f.name)
    temporary.chmod(0o600)
    os.replace(temporary, path)
    print(f'{args.command}: {args.user}; private registry updated')


if __name__ == '__main__': main()
