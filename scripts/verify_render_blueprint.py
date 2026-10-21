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
    automations = [service for service in services if service.get("type") in {"worker", "cron"}]
    automation = next((service for service in automations if "report-batch" in str(service.get("name", ""))), None)
    nv_ingestion = next((service for service in automations if "direct-nv-ingestion" in str(service.get("name", ""))), None)
    report_registry = next((service for service in automations if "report-link-registry" in str(service.get("name", ""))), None)
    config_push = next((service for service in automations if "config-push" in str(service.get("name", ""))), None)
    master_mirror = next((service for service in automations if "master-report-mirror" in str(service.get("name", ""))), None)
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
    for key in ("SNAPSHOT_DIR", "ONICORN_LOCK_FILE", "GOOGLE_APPLICATION_CREDENTIALS_JSON", "MASTER_SPREADSHEET_ID"):
        if key not in env:
            raise ValueError(f"automation env is missing {key}")
    if automation.get("type") == "worker" and not automation.get("disk"):
        raise ValueError("persistent worker requires durable state disk")
    if not nv_ingestion or nv_ingestion.get("type") != "cron":
        raise ValueError("direct NV ingestion cron is required")
    if str(nv_ingestion.get("startCommand", "")) != "npm run seed:nv-sources && npm run sync:nv":
        raise ValueError("direct NV cron must seed DB-authoritative sources and run sync:nv without Master catalog writes")
    nv_env = {item.get("key"): item for item in nv_ingestion.get("envVars", [])}
    for key in ("DATABASE_URL", "GOOGLE_APPLICATION_CREDENTIALS_JSON", "EMPLOYEE_FOLDER_ID", "CATALOG_AUTHORITY"):
        if key not in nv_env:
            raise ValueError(f"direct NV env is missing {key}")
    if str(nv_env["CATALOG_AUTHORITY"].get("value")) != "database":
        raise ValueError("direct NV registry authority must be database")
    for key in ("NV_PAGE_TIMEOUT_MS", "NV_SOURCE_TIMEOUT_MS", "NV_TOTAL_TIMEOUT_MS", "NV_HEARTBEAT_MS", "NV_SOURCE_RETRIES", "GOOGLE_REQUESTS_PER_MINUTE"):
        if key not in nv_env:
            raise ValueError(f"direct NV runtime env is missing {key}")
    if int(nv_env.get("NV_CONCURRENCY", {}).get("value", 99)) > 3:
        raise ValueError("direct NV concurrency exceeds three")
    if int(nv_env["GOOGLE_REQUESTS_PER_MINUTE"].get("value", 99)) > 60:
        raise ValueError("direct NV Google request rate exceeds per-user quota")
    if int(nv_env["NV_TOTAL_TIMEOUT_MS"].get("value", 0)) >= 30 * 60 * 1000:
        raise ValueError("direct NV total timeout must be shorter than its 30-minute schedule")
    if not report_registry or report_registry.get("type") != "cron":
        raise ValueError("report link registry cron is required")
    if str(report_registry.get("schedule", "")) != "5,35 * * * *":
        raise ValueError("report link registry must run five minutes after each catalog sync")
    if str(report_registry.get("startCommand", "")) != "npm run portal:ensure-active -- --apply":
        raise ValueError("report link registry must ensure active report keys")
    registry_env = {item.get("key"): item for item in report_registry.get("envVars", [])}
    for key in ("DATABASE_URL", "REPORT_REGISTRY_ENCRYPTION_KEY", "REPORT_REGISTRY_PRODUCTION"):
        if key not in registry_env:
            raise ValueError(f"report link registry env is missing {key}")
    if not config_push or config_push.get("type") != "cron":
        raise ValueError("config push cron is required")
    push_env = {item.get("key"): item for item in config_push.get("envVars", [])}
    if "GOOGLE_APPLICATION_CREDENTIALS_JSON" not in push_env:
        raise ValueError("config push env is missing GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if str(push_env.get("CONFIG_PUSH_PRODUCTION", {}).get("value")) != "0":
        raise ValueError("config push cron must remain dry-run by default")
    if str(push_env.get("CATALOG_AUTHORITY", {}).get("value")) != "database":
        raise ValueError("config push source authority must be database")
    if not master_mirror or master_mirror.get("type") != "cron":
        raise ValueError("Master reporting mirror cron is required")
    if str(master_mirror.get("schedule", "")) != "10,40 * * * *":
        raise ValueError("Master mirror must run after NV ingestion and report-key repair")
    if str(master_mirror.get("startCommand", "")) != "npm run master-mirror:apply":
        raise ValueError("Master mirror must use the guarded typed exporter")
    mirror_env = {item.get("key"): item for item in master_mirror.get("envVars", [])}
    for key in ("DATABASE_URL", "GOOGLE_APPLICATION_CREDENTIALS_JSON", "REPORT_REGISTRY_ENCRYPTION_KEY", "MASTER_SPREADSHEET_ID", "MASTER_MIRROR_SPREADSHEET_ID", "MASTER_MIRROR_PRODUCTION"):
        if key not in mirror_env:
            raise ValueError(f"Master mirror env is missing {key}")
    if str(mirror_env["MASTER_MIRROR_PRODUCTION"].get("value")) != "1":
        raise ValueError("Master mirror production gate must be explicit")
    if mirror_env["MASTER_MIRROR_SPREADSHEET_ID"].get("value") == mirror_env["MASTER_SPREADSHEET_ID"].get("value"):
        raise ValueError("Master mirror target must not be the legacy Master")
    web_env = {item.get("key"): item for item in web.get("envVars", [])}
    if str(web_env.get("CATALOG_AUTHORITY", {}).get("value")) != "database":
        raise ValueError("web catalog authority must be database")
    if str(web_env.get("CONFIG_PUSH_PRODUCTION", {}).get("value")) != "1" or str(web_env.get("CONFIG_PUSH_FULL_ROLLOUT", {}).get("value")) != "1":
        raise ValueError("web catalog saves must be allowed to queue the audited full CONFIG push")
    if str(web_env.get("MASTER_MIRROR_PRODUCTION", {}).get("value")) != "1":
        raise ValueError("web manual sync must explicitly enable the guarded Master mirror")
    if web_env.get("MASTER_MIRROR_SPREADSHEET_ID", {}).get("value") != mirror_env["MASTER_MIRROR_SPREADSHEET_ID"].get("value"):
        raise ValueError("web manual sync and cron must target the same Master reporting copy")


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "render.yaml")
    verify(load_yaml(path))
    print(f"RENDER_BLUEPRINT_OK {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
