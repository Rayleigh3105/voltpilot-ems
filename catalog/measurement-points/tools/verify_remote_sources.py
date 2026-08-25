#!/usr/bin/env python3
"""Update-only check that provenance URLs still yield the vendored bytes.

This deliberately does not run in the offline build gate. GitHub ``blob`` URLs
remain the human-readable provenance in the catalog and are translated to the
corresponding immutable raw endpoint only for byte comparison.
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import urllib.parse
import urllib.error
import urllib.request
from typing import Iterable

from cataloglib import ROOT, read_json
from generate import MANIFEST_PATH


def download_url(provenance_url: str) -> str:
    parsed = urllib.parse.urlparse(provenance_url)
    parts = parsed.path.strip("/").split("/")
    if parsed.netloc == "github.com" and len(parts) >= 5 and parts[2] == "blob":
        owner, repository, _, revision, *path = parts
        return f"https://raw.githubusercontent.com/{owner}/{repository}/{revision}/{'/'.join(path)}"
    return provenance_url


def download_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "VoltPilot-catalog-source-check/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()
    except urllib.error.URLError as urllib_error:
        # python.org's macOS interpreter may not be connected to the system
        # keychain even though the host TLS store is healthy. Keep certificate
        # verification enabled by falling back to curl's system TLS backend.
        try:
            result = subprocess.run(
                ["curl", "--fail", "--silent", "--show-error", "--location", url],
                check=True,
                capture_output=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError) as curl_error:
            raise RuntimeError(f"unable to download {url}: {urllib_error}") from curl_error
        return result.stdout


def checks_for_source(source: dict) -> Iterable[tuple[str, str, str]]:
    adapter = source["adapter"]
    if adapter == "sunspec":
        for model_id, expected in source["models"]:
            yield (
                source["path_pattern"].format(model_id=model_id),
                source["source_url_pattern"].format(model_id=model_id),
                expected,
            )
    elif adapter == "shelly":
        raw_manifest = read_json(ROOT / source["raw_manifest_path"])
        for raw_source in raw_manifest["sources"]:
            yield raw_source["path"], raw_source["url"], raw_source["sha256"]
    else:
        yield source["path"], source["source_url"], source["source_sha256"]
        if adapter == "goe":
            yield source["german_labels_path"], source["german_labels_url"], source["german_labels_sha256"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", action="append", help="manifest source id; repeatable (default: all)")
    args = parser.parse_args()
    selected = set(args.source or [])
    manifest = read_json(MANIFEST_PATH)
    known = {source["id"] for source in manifest["sources"]}
    if selected - known:
        raise SystemExit(f"unknown source ids: {sorted(selected - known)}")
    failures = []
    checked = 0
    for source in manifest["sources"]:
        if selected and source["id"] not in selected:
            continue
        for path, provenance_url, expected in checks_for_source(source):
            actual = hashlib.sha256(download_bytes(download_url(provenance_url))).hexdigest()
            checked += 1
            if actual != expected:
                failures.append(f"{path}: expected {expected}, remote returned {actual}")
    if failures:
        raise SystemExit("remote source mismatch:\n" + "\n".join(f"- {failure}" for failure in failures))
    print(f"verified {checked} remote source snapshots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
