"""Bounded, thread-safe login failure tracking."""
from __future__ import annotations

import math
import os
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager


def bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(os.environ.get(name, str(default)))))
    except ValueError:
        return default


def bounded_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        return max(minimum, min(maximum, float(os.environ.get(name, str(default)))))
    except ValueError:
        return default


LOGIN_FREE_FAILURES = bounded_int("PAPER_LOGIN_FREE_FAILURES", 3, 0, 10)
LOGIN_BASE_DELAY = bounded_float("PAPER_LOGIN_BASE_DELAY", 1.0, 0.25, 10.0)
LOGIN_MAX_DELAY = bounded_float("PAPER_LOGIN_MAX_DELAY", 60.0, 1.0, 300.0)
LOGIN_FAILURE_WINDOW = bounded_float("PAPER_LOGIN_FAILURE_WINDOW", 900.0, 60.0, 86_400.0)
LOGIN_MAX_TRACKED_IPS = bounded_int("PAPER_LOGIN_MAX_TRACKED_IPS", 4096, 128, 65_536)


class FailureState:
    __slots__ = ("blocked_until", "failures", "last_failure")

    def __init__(self, failures: int, last_failure: float, blocked_until: float) -> None:
        self.failures = failures
        self.last_failure = last_failure
        self.blocked_until = blocked_until


class LoginAttemptLimiter:
    """Thread-safe, bounded per-client exponential login cooldowns."""

    def __init__(
        self,
        *,
        free_failures: int = LOGIN_FREE_FAILURES,
        base_delay: float = LOGIN_BASE_DELAY,
        max_delay: float = LOGIN_MAX_DELAY,
        failure_window: float = LOGIN_FAILURE_WINDOW,
        max_entries: int = LOGIN_MAX_TRACKED_IPS,
    ) -> None:
        self.free_failures = max(0, free_failures)
        self.base_delay = max(0.01, base_delay)
        self.max_delay = max(self.base_delay, max_delay)
        self.failure_window = max(self.max_delay, failure_window)
        self.max_entries = max(1, max_entries)
        self._states: OrderedDict[str, FailureState] = OrderedDict()
        self._lock = threading.Lock()
        self._active: set[str] = set()

    def _prune(self, now: float) -> None:
        while self._states:
            _, state = next(iter(self._states.items()))
            if now - state.last_failure < self.failure_window:
                break
            self._states.popitem(last=False)
        while len(self._states) > self.max_entries:
            self._states.popitem(last=False)

    def _retry_after(self, client: str, now: float) -> int:
        self._prune(now)
        state = self._states.get(client)
        if state is None or state.blocked_until <= now:
            return 0
        return max(1, math.ceil(state.blocked_until - now))

    def retry_after(self, client: str, now: float | None = None) -> int:
        current = time.monotonic() if now is None else now
        with self._lock:
            return self._retry_after(client, current)

    @contextmanager
    def attempt(self, client: str):
        """Allow one in-flight login per client so bursts cannot bypass cooldowns."""
        with self._lock:
            retry = self._retry_after(client, time.monotonic())
            if client in self._active:
                retry = max(retry, 1)
            if not retry:
                self._active.add(client)
        try:
            yield retry
        finally:
            if not retry:
                with self._lock:
                    self._active.remove(client)

    def record_failure(self, client: str, now: float | None = None) -> int:
        current = time.monotonic() if now is None else now
        with self._lock:
            return self._record_failure(client, current)

    def _record_failure(self, client: str, now: float) -> int:
        self._prune(now)
        previous = self._states.get(client)
        failures = (
            previous.failures + 1
            if previous is not None and now - previous.last_failure < self.failure_window
            else 1
        )
        delay = 0.0
        if failures > self.free_failures:
            exponent = min(failures - self.free_failures - 1, 30)
            delay = min(self.max_delay, self.base_delay * (2**exponent))
        self._states[client] = FailureState(failures, now, now + delay)
        self._states.move_to_end(client)
        self._prune(now)
        return max(1, math.ceil(delay)) if delay else 0

    def evaluate_attempt(
        self,
        client: str,
        password_matches: bool,
        now: float | None = None,
    ) -> tuple[bool, int]:
        """Atomically accept, reject, or throttle a completed password comparison."""
        current = time.monotonic() if now is None else now
        with self._lock:
            self._prune(current)
            state = self._states.get(client)
            if state is not None and state.blocked_until > current:
                return False, max(1, math.ceil(state.blocked_until - current))
            if password_matches:
                self._states.pop(client, None)
                return True, 0
            return False, self._record_failure(client, current)

    def record_success(self, client: str) -> None:
        with self._lock:
            self._states.pop(client, None)
