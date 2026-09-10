"""Typed, fail-closed environment configuration for production workers."""
from __future__ import annotations
from dataclasses import dataclass
import os

class ConfigError(ValueError): pass

def _required(name: str) -> str:
    value=os.getenv(name, '').strip()
    if not value: raise ConfigError(f'{name} is required')
    return value

@dataclass(frozen=True)
class Settings:
    database_url: str
    snapshot_dir: str
    lock_file: str
    notify_url: str|None
    production: bool

    @classmethod
    def from_env(cls, production=False):
        db=_required('DATABASE_URL') if production else os.getenv('DATABASE_URL','').strip()
        return cls(db, os.getenv('SNAPSHOT_DIR','.runtime'), os.getenv('ONICORN_LOCK_FILE','.runtime/run.lock'), os.getenv('FAILURE_NOTIFY_URL') or None, production)

    def validate(self):
        if self.production and ('localhost' in self.database_url or '127.0.0.1' in self.database_url):
            raise ConfigError('production DATABASE_URL must not point to localhost')
        if self.notify_url and not self.notify_url.startswith(('https://','http://')): raise ConfigError('FAILURE_NOTIFY_URL must be http(s)')
        if self.production and not os.path.isabs(self.snapshot_dir):
            raise ConfigError('production SNAPSHOT_DIR must be an absolute path')
        return self
