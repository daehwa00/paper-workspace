import asyncio
import json
from collections import defaultdict

from websockets.asyncio.server import serve

rooms = defaultdict(set)
actors = {}
MAX_EVENT_BYTES = 32_000


def short_text(value, limit):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("invalid collaboration field")
    return value.strip()[:limit]


async def broadcast(room, event, exclude=None):
    message = json.dumps(event)
    for socket in list(rooms[room]):
        if socket != exclude:
            try:
                await socket.send(message)
            except Exception:
                rooms[room].discard(socket)


async def handler(socket):
    room = "default"
    actor = None
    try:
        async for raw in socket:
            if len(raw.encode("utf-8")) > MAX_EVENT_BYTES:
                await socket.close(code=1009, reason="event too large")
                return
            event = json.loads(raw)
            if event.get("type") == "join":
                rooms[room].discard(socket)
                room = short_text(event.get("project"), 120)
                incoming = event["actor"]
                actor = {
                    "id": short_text(incoming.get("id"), 80),
                    "name": short_text(incoming.get("name"), 32),
                    "color": short_text(incoming.get("color"), 16),
                }
                rooms[room].add(socket)
                await socket.send(json.dumps({"type": "presence", "actors": [actors[s] for s in rooms[room] if s != socket and s in actors]}))
                actors[socket] = actor
                await broadcast(room, {"type": "join", "actor": actor}, socket)
            elif event.get("type") == "cursor" and actor:
                actor["active_file"] = event.get("file")
                actor["line"] = event.get("line")
                actor["selection"] = event.get("selection")
                await broadcast(room, {"type": "cursor", "actor": actor, "file": event.get("file"), "selection": event.get("selection")}, socket)
    finally:
        rooms[room].discard(socket)
        actors.pop(socket, None)
        if actor:
            await broadcast(room, {"type": "leave", "actor": actor})


async def main():
    async with serve(handler, "0.0.0.0", 8765, ping_interval=5, ping_timeout=5, max_size=MAX_EVENT_BYTES):
        await asyncio.Future()


asyncio.run(main())
