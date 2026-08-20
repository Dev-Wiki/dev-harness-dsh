#!/usr/bin/env python3
"""Verify the repository and build a local npm release tarball."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = ROOT / "package.json"
DEFAULT_OUTPUT_DIR = ROOT / "dist"
REQUIRED_PACKAGE_FILES = frozenset(
    {
        "cordis.patch.yml",
        "lib/index.d.ts",
        "lib/index.js",
        "package.json",
    }
)
FORBIDDEN_PACKAGE_ROOTS = frozenset({"node_modules", "src", "tests"})


class ReleaseError(RuntimeError):
    """Raised when a release artifact cannot be built safely."""


def fail(message: str) -> NoReturn:
    raise ReleaseError(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the canonical full verification and create a local npm .tgz package. "
            "This command never publishes to a registry."
        )
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="artifact directory (default: ./dist)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="atomically replace an existing tarball with the same name",
    )
    return parser.parse_args()


def load_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {MANIFEST_PATH}: {error}")

    if not isinstance(manifest, dict):
        fail("package.json must contain a JSON object")
    for field in ("name", "version"):
        value = manifest.get(field)
        if not isinstance(value, str) or not value.strip():
            fail(f"package.json field {field!r} must be a non-empty string")
    return manifest


def npm_command() -> str:
    executable = shutil.which("npm")
    if executable is None:
        fail("npm was not found on PATH")
    return executable


def release_environment() -> dict[str, str]:
    environment = os.environ.copy()
    if "npm_config_cache" not in environment and "NPM_CONFIG_CACHE" not in environment:
        environment["npm_config_cache"] = str(ROOT / ".npm-cache" / "release")
    return environment


def run_full_verification(npm: str, environment: dict[str, str]) -> None:
    print("[release] running canonical full verification", flush=True)
    subprocess.run(
        [npm, "run", "harness:full"],
        cwd=ROOT,
        env=environment,
        check=True,
    )


def parse_pack_result(stdout: str) -> dict[str, Any]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as error:
        fail(f"npm pack did not return valid JSON: {error}")
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        fail("npm pack must describe exactly one package")
    return payload[0]


def validate_pack_result(
    result: dict[str, Any], manifest: dict[str, Any], staging_dir: Path
) -> tuple[Path, list[str]]:
    for field in ("name", "version"):
        if result.get(field) != manifest[field]:
            fail(
                f"npm pack {field} mismatch: expected {manifest[field]!r}, "
                f"got {result.get(field)!r}"
            )

    filename = result.get("filename")
    if not isinstance(filename, str) or not filename.endswith(".tgz"):
        fail("npm pack returned an invalid tarball filename")
    if Path(filename).name != filename:
        fail("npm pack returned a tarball filename containing a path")

    files = result.get("files")
    if not isinstance(files, list) or not files:
        fail("npm pack returned an empty or invalid file list")
    paths: list[str] = []
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            fail("npm pack returned an invalid file entry")
        path = entry["path"]
        parsed = PurePosixPath(path)
        if parsed.is_absolute() or ".." in parsed.parts:
            fail(f"npm pack returned an unsafe file path: {path!r}")
        if parsed.parts and parsed.parts[0] in FORBIDDEN_PACKAGE_ROOTS:
            fail(f"forbidden path included in release package: {path!r}")
        paths.append(path)

    missing = sorted(REQUIRED_PACKAGE_FILES.difference(paths))
    if missing:
        fail(f"release package is missing required files: {', '.join(missing)}")

    entry_count = result.get("entryCount")
    if not isinstance(entry_count, int) or isinstance(entry_count, bool):
        fail("npm pack returned an invalid entryCount")
    if entry_count != len(paths):
        fail(f"npm pack entryCount mismatch: reported {entry_count}, listed {len(paths)}")

    tarball = staging_dir / filename
    if not tarball.is_file() or tarball.is_symlink():
        fail(f"npm pack did not create a regular tarball: {tarball}")
    if tarball.resolve().parent != staging_dir.resolve():
        fail("npm pack created the tarball outside the staging directory")

    reported_size = result.get("size")
    actual_size = tarball.stat().st_size
    if not isinstance(reported_size, int) or isinstance(reported_size, bool):
        fail("npm pack returned an invalid size")
    if reported_size != actual_size:
        fail(f"npm pack size mismatch: reported {reported_size}, actual {actual_size}")
    return tarball, paths


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def install_artifact(staged: Path, destination: Path, force: bool) -> None:
    try:
        if force:
            os.replace(staged, destination)
        else:
            os.link(staged, destination)
    except FileExistsError:
        fail(f"release artifact already exists: {destination} (use --force to replace it)")
    except OSError as error:
        fail(f"cannot install release artifact at {destination}: {error}")


def build_release(args: argparse.Namespace) -> Path:
    manifest = load_manifest()
    npm = npm_command()
    environment = release_environment()
    run_full_verification(npm, environment)

    output_dir = args.output_dir
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        fail(f"cannot create output directory {output_dir}: {error}")
    if not output_dir.is_dir():
        fail(f"output path is not a directory: {output_dir}")

    with tempfile.TemporaryDirectory(prefix=".release-", dir=output_dir) as temporary:
        staging_dir = Path(temporary)
        print("[release] creating staged npm package", flush=True)
        completed = subprocess.run(
            [
                npm,
                "pack",
                "--json",
                "--ignore-scripts",
                "--pack-destination",
                str(staging_dir),
            ],
            cwd=ROOT,
            env=environment,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if completed.stderr:
            print(completed.stderr, file=sys.stderr, end="")
        result = parse_pack_result(completed.stdout)
        staged, paths = validate_pack_result(result, manifest, staging_dir)
        sha256 = sha256_file(staged)
        destination = output_dir / staged.name
        install_artifact(staged, destination, args.force)

    print(f"[release] package: {destination}")
    print(f"[release] entries: {len(paths)}")
    print(f"[release] size: {destination.stat().st_size} bytes")
    print(f"[release] sha256: {sha256}")
    print("[release] local package created; nothing was published")
    return destination


def main() -> int:
    args = parse_args()
    try:
        build_release(args)
    except subprocess.CalledProcessError as error:
        print(f"[release] command failed with exit code {error.returncode}", file=sys.stderr)
        return error.returncode or 1
    except ReleaseError as error:
        print(f"[release] error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
