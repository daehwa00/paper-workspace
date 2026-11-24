"""Rebuttal service entrypoint and compatibility exports."""
from __future__ import annotations

import copy
import base64
import io
import zipfile
import urllib.request
import urllib.error
import hashlib
import hmac
import importlib.util
import json
import logging
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Also support stdlib importlib loaders used by project tests and direct Docker execution.
_MODULE_DIR = str(Path(__file__).resolve().parent)
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)
try:
    from .imports import ValidationError, UpstreamRequestError, SessionPool, digest, json_request, prepare_import, normalize_reviews, reparse_staged_import, text
    from .exports import assemble, validate_rules
except ImportError:
    from imports import ValidationError, UpstreamRequestError, SessionPool, digest, json_request, prepare_import, normalize_reviews, reparse_staged_import, text
    from exports import assemble, validate_rules

if __package__:
    from .state import MAX_REQUEST_BYTES, MAX_STATE_BYTES, SAFE_ID, TASKS, TRANSLATION_TASKS, SECRET_KEYS, ROUND_ARRAYS, now, uid, identifier, NotFound, Conflict, Forbidden, reject_secrets, empty_state, new_round, lookup, find_round, utf16_offsets, checked_texts, stale_mapping, invalidate, validate_edit
    from .jobs import analysis_failure
    from .http_api import ProjectCatalog, RebuttalHandler
    from .rebuttal_store import RebuttalStore as _RebuttalStore
else:
    from state import MAX_REQUEST_BYTES, MAX_STATE_BYTES, SAFE_ID, TASKS, TRANSLATION_TASKS, SECRET_KEYS, ROUND_ARRAYS, now, uid, identifier, NotFound, Conflict, Forbidden, reject_secrets, empty_state, new_round, lookup, find_round, utf16_offsets, checked_texts, stale_mapping, invalidate, validate_edit
    from jobs import analysis_failure
    from http_api import ProjectCatalog, RebuttalHandler
    from rebuttal_store import RebuttalStore as _RebuttalStore


class RebuttalStore(_RebuttalStore):
    # Preserve the request injection point exported by this entrypoint.
    @staticmethod
    def _request(*args, **kwargs):
        return json_request(*args, **kwargs)


def create_server():
    store = RebuttalStore(os.environ.get('REBUTTAL_DB_PATH', '/data/rebuttal.sqlite3'))
    RebuttalHandler.store = store
    RebuttalHandler.sessions = SessionPool()
    RebuttalHandler.enabled = os.environ.get('REBUTTAL_ENABLED', 'false').lower() in {'1', 'true', 'yes'}
    RebuttalHandler.actor_mode = os.environ.get('REBUTTAL_ACTOR_MODE', 'shared').lower()
    if RebuttalHandler.actor_mode not in {'shared', 'proxy'}: raise ValueError('invalid REBUTTAL_ACTOR_MODE')
    RebuttalHandler.shared_actor = os.environ.get('REBUTTAL_SHARED_ACTOR', 'Shared user')
    RebuttalHandler.shared_scope = os.environ.get('REBUTTAL_SHARED_SCOPE', 'false').lower() in {'1', 'true', 'yes'}
    runtime = os.environ.get('REBUTTAL_PROJECT_RUNTIME')
    RebuttalHandler.catalog = ProjectCatalog(runtime) if runtime else None
    RebuttalHandler.feature_projects = set(filter(None, os.environ.get('REBUTTAL_PROJECTS', '').split(','))) or None
    RebuttalHandler.allowed_projects = None
    host = os.environ.get('REBUTTAL_HOST', '0.0.0.0')
    port = int(os.environ.get('REBUTTAL_PORT', '8020'))
    server = ThreadingHTTPServer((host, port), RebuttalHandler)
    store.start()
    return server


if __name__ == '__main__':
    server = create_server()
    try: server.serve_forever()
    finally: server.RequestHandlerClass.store.close(); server.server_close()
