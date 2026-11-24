"""Bound concurrent connections and their socket inactivity."""
from http.server import ThreadingHTTPServer
from threading import BoundedSemaphore


class BoundedHTTPServer(ThreadingHTTPServer):
    def __init__(self, address, handler, *, max_workers=8, socket_timeout=10):
        self._workers = BoundedSemaphore(max_workers)
        self.socket_timeout = socket_timeout
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self._workers.acquire(blocking=False):
            # Never wait for slow clients on the server's accepting thread.
            self.shutdown_request(request)
            return
        try:
            request.settimeout(self.socket_timeout)
            super().process_request(request, client_address)
        except BaseException:
            self._workers.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._workers.release()
