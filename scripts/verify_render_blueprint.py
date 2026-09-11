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
    automation = next((service for service in services if service.get("type") in {"worker", "cron"}), None)
    if not web or web.get("healthCheckPath") != "/healthz":
        raise ValueError("web service must preserve /healthz")
    if not automation:
        raise ValueError("a worker or cron automation service is required")
    command = str(automation.get("startCommand", ""))
    if "runner_cli" not in command or not any(word in command for word in (" sync", " worker", " scheduled-run")):
        raise ValueError("automation must use the batch runner")
    if automation.get("type") == "cron" and "scheduled-run --production" not in command:
        raise ValueError("cron automation must explicitly run the gated production schedule")
    env = {item.get("key"): item for item in automation.get("envVars", [])}
    for key in ("SNAPSHOT_DIR", "ONICORN_LOCK_FILE", "GOOGLE_APPLICATION_CREDENTIALS", "MASTER_SPREADSHEET_ID"):
        if key not in env:
            raise ValueError(f"automation env is missing {key}")
    if automation.get("type") == "worker" and not automation.get("disk"):
        raise ValueError("persistent worker requires durable state disk")


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "render.yaml")
    verify(load_yaml(path))
    print(f"RENDER_BLUEPRINT_OK {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
