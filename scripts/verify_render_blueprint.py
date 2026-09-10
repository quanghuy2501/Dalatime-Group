#!/usr/bin/env python3
"""Validate Render Blueprint YAML and Onicorn's fail-closed deployment invariants."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def load_yaml(path: Path) -> dict:
    ruby = "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))"
    result = subprocess.run(
        ["ruby", "-e", ruby, str(path)], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise ValueError(f"invalid YAML: {result.stderr.strip()}")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("Blueprint root must be a mapping")
    return value


def verify(blueprint: dict) -> None:
    services = blueprint.get("services")
    if not isinstance(services, list) or not services:
        raise ValueError("services must be a non-empty list")
    names = [service.get("name") for service in services]
    if len(names) != len(set(names)):
        raise ValueError("service names must be unique")
    web = next((service for service in services if service.get("type") == "web"), None)
    worker = next((service for service in services if service.get("type") == "worker"), None)
    if not web or web.get("healthCheckPath") != "/healthz":
        raise ValueError("web service must preserve /healthz")
    if not worker:
        raise ValueError("a background worker is required")
    command = str(worker.get("startCommand", ""))
    if "runner_cli" not in command or " worker" not in command:
        raise ValueError("worker must use the batch runner")
    if "--production" in command:
        raise ValueError("Blueprint worker must default to dry-run; production is explicit")
    env = {item.get("key"): item for item in worker.get("envVars", [])}
    for key in ("SNAPSHOT_DIR", "ONICORN_LOCK_FILE", "MASTER_SNAPSHOT_PATH", "REPORT_SNAPSHOT_PATH"):
        if key not in env:
            raise ValueError(f"worker env is missing {key}")
    if not worker.get("disk"):
        raise ValueError("worker requires durable state disk")


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "render.yaml")
    verify(load_yaml(path))
    print(f"RENDER_BLUEPRINT_OK {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
