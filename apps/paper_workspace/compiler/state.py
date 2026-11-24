from __future__ import annotations

import hashlib
import os
import re
import secrets
import signal
import subprocess
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from http import HTTPStatus

COMPILE_CACHE_TTL = 600
COMPILE_CACHE_ITEMS = 16
COMPILE_CACHE_MAX_BYTES = max(1, int(os.environ.get("PAPER_COMPILE_CACHE_MAX_BYTES", "100663296")))
BUILD_STATE_TTL = 600
BUILD_STATE_ITEMS = 16
BUILD_STATE_MAX_BYTES = 2_000_000
BUILD_STATE_TOTAL_BYTES = 16_000_000
COMPILE_SINGLEFLIGHT_WAIT_SECONDS = max(1, int(os.environ.get("PAPER_COMPILE_SINGLEFLIGHT_WAIT_SECONDS", "35")))

BuildScope = tuple[str, str, str]


@dataclass(frozen=True)
class BuildState:
    created_at: float
    binding: tuple[str, ...]
    artifacts: dict[str, bytes]
    bibliography_signature: str
    size_bytes: int


@dataclass(frozen=True)
class CompileResult:
    pdf: bytes
    synctex: bytes
    elapsed_ms: int
    paths: frozenset[str] = frozenset()
    artifacts: dict[str, bytes] = field(default_factory=dict)
    bibliography_signature: str = ""
    warm: bool = False
    passes: int = 0
    bibtex_runs: int = 0
    pdf_audit: dict[str, object] = field(default_factory=dict)
    compile_id: str = ""

    @property
    def size_bytes(self) -> int:
        return len(self.pdf) + len(self.synctex) + sum(
            len(name.encode()) + len(data) for name, data in self.artifacts.items()
        ) + sum(len(path.encode()) + 128 for path in self.paths)


@dataclass(frozen=True)
class CompileFailure:
    status: HTTPStatus
    message: str


class CompileFlight(threading.Event):
    def __init__(self) -> None:
        super().__init__()
        self.outcome: CompileResult | CompileFailure | None = None
        self.generation: BuildGeneration | None = None


@dataclass(eq=False)
class BuildGeneration:
    scope: BuildScope
    key: str = ""
    process: subprocess.Popen | None = None


@dataclass(frozen=True)
class SyncTeXRecord:
    data: bytes
    paths: frozenset[str]

    @property
    def size_bytes(self) -> int:
        return len(self.data) + sum(len(path.encode()) + 128 for path in self.paths)


def terminate_process(process: subprocess.Popen) -> None:
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


class CompilerRuntime:
    def __init__(self, *, settings=None, compile_limit: int = 2,
                 request_limit: int | None = None) -> None:
        self.settings = settings
        self.synctex_key = secrets.token_bytes(32)
        self.compile_cache = OrderedDict()
        self.synctex_cache = OrderedDict()
        self.build_states: OrderedDict[str, BuildState] = OrderedDict()
        self.cache_lock = threading.Lock()
        self.build_state_lock = threading.Lock()
        self.process_lock = threading.Lock()
        self.generations: dict[BuildScope, BuildGeneration] = {}
        self.compile_slots = threading.BoundedSemaphore(compile_limit)
        self.request_slots = threading.BoundedSemaphore(compile_limit + 4 if request_limit is None else request_limit)
        self.rebuttal_slots = threading.BoundedSemaphore(2)
        self.flight_lock = threading.Lock()
        self.flights: dict[str, CompileFlight] = {}

    def _setting(self, name: str) -> int:
        return getattr(self.settings, name, globals()[name])

    def claim_flight(self, key: str) -> tuple[bool, CompileFlight]:
        with self.flight_lock:
            return self._claim_flight(key)

    def _claim_flight(self, key: str) -> tuple[bool, CompileFlight]:
        flight = self.flights.get(key)
        if flight is not None:
            return False, flight
        flight = self.flights[key] = CompileFlight()
        return True, flight

    def claim_build(self, key: str, scope: BuildScope | None):
        # Elect the flight and register its generation in one critical section.
        with self.flight_lock, self.process_lock:
            flight = self.flights.get(key)
            if flight is not None and self._is_current(flight.generation):
                if scope is not None and (flight.generation is None or flight.generation.scope != scope):
                    self._supersede(scope, key)
                return False, flight, None
            flight = self.flights[key] = CompileFlight()
            if scope is not None:
                self._supersede(scope, key)
                flight.generation = self.generations[scope] = BuildGeneration(scope, key)
            return True, flight, flight.generation

    def supersede_for_cache_hit(self, scope: BuildScope, key: str) -> None:
        with self.process_lock:
            self._supersede(scope, key)

    def _supersede(self, scope: BuildScope, key: str) -> None:
        previous = self.generations.get(scope)
        if previous is not None and previous.key != key:
            del self.generations[scope]
            if previous.process is not None:
                terminate_process(previous.process)

    def finish_flight(self, key: str, flight: CompileFlight, outcome=None) -> None:
        with self.flight_lock:
            if self.flights.get(key) is flight:
                del self.flights[key]
            if outcome is not None:
                flight.outcome = outcome
            flight.set()

    def _is_current(self, generation: BuildGeneration | None) -> bool:
        return generation is None or self.generations.get(generation.scope) is generation

    def assert_current(self, generation: BuildGeneration | None) -> None:
        with self.process_lock:
            if not self._is_current(generation):
                raise RuntimeError("compile superseded by a newer request")

    def spawn(self, generation: BuildGeneration, command: list[str], **kwargs) -> subprocess.Popen:
        with self.process_lock:
            if not self._is_current(generation):
                raise RuntimeError("compile superseded by a newer request")
            process = subprocess.Popen(command, **kwargs)
            generation.process = process
            return process

    def clear_process(self, generation: BuildGeneration, process: subprocess.Popen) -> None:
        with self.process_lock:
            if generation.process is process:
                generation.process = None

    def end_generation(self, generation: BuildGeneration | None) -> None:
        if generation is not None:
            with self.process_lock:
                if self.generations.get(generation.scope) is generation:
                    del self.generations[generation.scope]

    def _prune_caches(self, now: float) -> None:
        ttl = self._setting("COMPILE_CACHE_TTL")
        items = self._setting("COMPILE_CACHE_ITEMS")
        for cache, limit in ((self.compile_cache, items), (self.synctex_cache, items * 2)):
            for key, (created_at, _) in list(cache.items()):
                if now - created_at > ttl:
                    del cache[key]
            while len(cache) > limit:
                cache.popitem(last=False)
        total = sum(item.size_bytes for _, item in self.compile_cache.values())
        total += sum(item.size_bytes for _, item in self.synctex_cache.values())
        budget = self._setting("COMPILE_CACHE_MAX_BYTES")
        while total > budget:
            available = [cache for cache in (self.compile_cache, self.synctex_cache) if cache]
            oldest = min(available, key=lambda cache: next(iter(cache.values()))[0])
            _, (_, item) = oldest.popitem(last=False)
            total -= item.size_bytes

    def cache_get(self, key: str) -> CompileResult | None:
        with self.cache_lock:
            self._prune_caches(time.monotonic())
            cached = self.compile_cache.get(key)
            if cached is not None:
                self.compile_cache.move_to_end(key)
                return cached[1]
        return None

    def cache_put(self, key: str, result: CompileResult, actor: str, *,
                  generation: BuildGeneration | None = None) -> CompileResult:
        digest = hashlib.sha256(actor.encode() + b"\0")
        digest.update(result.pdf)
        digest.update(result.synctex)
        # Different projects can produce identical PDF and SyncTeX bytes.
        for path in sorted(result.paths):
            digest.update(b"\0")
            digest.update(path.encode())
        result = replace(result, compile_id=digest.hexdigest()[:24])
        now = time.monotonic()
        with self.process_lock, self.cache_lock:
            if not self._is_current(generation):
                raise RuntimeError("compile superseded by a newer request")
            self.compile_cache[key] = (now, result)
            self.compile_cache.move_to_end(key)
            self._remember_synctex(result, actor, now)
            self._prune_caches(now)
        return result

    def _remember_synctex(self, result: CompileResult, actor: str, now: float) -> None:
        key = (actor, result.compile_id)
        record = SyncTeXRecord(result.synctex, result.paths)
        self.synctex_cache[key] = (now, record)
        self.synctex_cache.move_to_end(key)

    def refresh_synctex(self, result: CompileResult, actor: str) -> None:
        now = time.monotonic()
        with self.cache_lock:
            self._remember_synctex(result, actor, now)
            self._prune_caches(now)

    def get_synctex(self, actor: str, *, compile_id: str) -> SyncTeXRecord | None:
        with self.cache_lock:
            self._prune_caches(time.monotonic())
            key = (actor, compile_id)
            entry = self.synctex_cache.get(key)
            if entry is not None:
                self.synctex_cache.move_to_end(key)
                return entry[1]
        return None

    def _prune_build_states(self, now: float) -> None:
        for token, state in list(self.build_states.items()):
            if now - state.created_at > self._setting("BUILD_STATE_TTL"):
                del self.build_states[token]
        while len(self.build_states) > self._setting("BUILD_STATE_ITEMS"):
            self.build_states.popitem(last=False)
        while sum(state.size_bytes for state in self.build_states.values()) > self._setting("BUILD_STATE_TOTAL_BYTES"):
            self.build_states.popitem(last=False)

    def build_state_get(self, token: str | None, binding: tuple[str, ...]) -> BuildState | None:
        if not token or not re.fullmatch(r"[0-9a-f]{32}", token):
            return None
        with self.build_state_lock:
            self._prune_build_states(time.monotonic())
            state = self.build_states.get(token)
            if state is not None and state.binding == binding:
                self.build_states.move_to_end(token)
                return state
        return None

    def build_state_put(self, binding: tuple[str, ...], artifacts: dict[str, bytes],
                        bibliography_signature: str, previous_token: str | None = None) -> str | None:
        size_bytes = sum(len(name.encode()) + len(value) for name, value in artifacts.items())
        with self.build_state_lock:
            previous = self.build_states.get(previous_token)
            if previous is not None and previous.binding == binding:
                del self.build_states[previous_token]
            if not artifacts or size_bytes > self._setting("BUILD_STATE_MAX_BYTES"):
                return None
            token = secrets.token_hex(16)
            state = BuildState(time.monotonic(), binding, artifacts, bibliography_signature, size_bytes)
            self.build_states[token] = state
            self._prune_build_states(state.created_at)
            return token if token in self.build_states else None
