"""Atomic file replacement for backup storage."""
import os
import tempfile
from pathlib import Path


def write_atomic(target: Path, content: bytes) -> None:
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, target)
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
