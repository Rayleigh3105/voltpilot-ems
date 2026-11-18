"""Wie ein Testprozess den Port eines Wegwerf-Postgres erreicht - auf dem Rechner wie im Runner.

Gleicher Inhalt in ``services/forecast/tests/wegwerf_netz.py``; beide zusammen ändern.

Der Forgejo-Runner fährt den Job selbst in einem Container am gemounteten Socket des
Wirts. Ein mit ``-p 127.0.0.1::5432`` veröffentlichter Port liegt dann auf der Loopback
des WIRTS, und ``127.0.0.1`` im Job ist der Job selbst: jede Verbindung endete nach dem
ganzen Bereitschaftsfenster mit "Connection refused" (Nachtlauf, ``optimization`` rot in
jedem Lauf seit 554). Läuft der Testprozess in einem Container dieses Daemons, kommt der
Postgres darum in DENSELBEN Netz-Namensraum (``--network container:<job>``, dieselbe
Antwort wie ``frontend/portal/test/smoke-lib.sh``) und lauscht dort auf einem freien Port;
sonst wie bisher auf der Loopback des Rechners. Beide Wege verbinden sich mit
``127.0.0.1`` und veröffentlichen nichts auf anderen Schnittstellen.
"""

from __future__ import annotations

import re
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Docker hängt hostname/hosts/resolv.conf des Containers aus seinem eigenen
# Verzeichnis ein; die Zeile in mountinfo nennt damit die volle Kennung.
_EIGENE_KENNUNG = re.compile(
    r"/containers/([0-9a-f]{64})/(?:hostname|hosts|resolv\.conf) ")


@dataclass(frozen=True)
class PostgresNetz:
    argumente: tuple[str, ...]
    """Für ``docker run``, vor dem Abbild."""
    _port_im_job: int | None

    def port(self, name: str) -> int:
        """Port, unter dem ``127.0.0.1`` den Postgres im Container ``name`` erreicht."""
        if self._port_im_job is not None:
            return self._port_im_job
        return int(subprocess.run(
            ["docker", "port", name, "5432/tcp"],
            check=True, capture_output=True, text=True,
        ).stdout.split()[0].rsplit(":", 1)[1])


def _eigener_container() -> str | None:
    """Kennung des Containers, in dem dieser Prozess läuft - nur, wenn der Daemon ihn kennt."""
    try:
        treffer = _EIGENE_KENNUNG.search(Path("/proc/self/mountinfo").read_text())
    except OSError:
        return None
    if treffer is None:
        return None
    kennung = treffer.group(1)
    bekannt = subprocess.run(["docker", "inspect", kennung], capture_output=True)
    return kennung if bekannt.returncode == 0 else None


def postgres_netz() -> PostgresNetz:
    job = _eigener_container()
    if job is None:
        return PostgresNetz(("-p", "127.0.0.1::5432"), None)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        frei = probe.getsockname()[1]
    # PGPORT gilt für den Server und für das psql im Einstiegsskript des Abbilds.
    return PostgresNetz(
        ("--network", f"container:{job}", "-e", f"PGPORT={frei}"), frei)
