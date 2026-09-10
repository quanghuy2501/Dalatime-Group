"""Supabase Storage REST adapter for immutable snapshot publication."""
from __future__ import annotations
import hashlib, json, os, re, urllib.error, urllib.request
from pathlib import Path

class StorageError(RuntimeError): pass

def safe_path(value: str) -> str:
    p = str(value or '').replace('\\','/')
    if not p or p.startswith('/') or '\x00' in p or any(part in ('','.','..') for part in p.split('/')):
        raise ValueError('invalid storage object path')
    if not re.fullmatch(r'[A-Za-z0-9._/-]+', p): raise ValueError('invalid storage object path')
    return p

def sha256_bytes(data: bytes) -> str: return hashlib.sha256(data).hexdigest()

def sha256_file(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

class SupabaseStorage:
    def __init__(self, url: str|None=None, key: str|None=None, bucket: str|None=None, opener=None):
        self.url=(url or os.getenv('SUPABASE_URL','')).rstrip('/')
        self.key=key or os.getenv('SUPABASE_SERVICE_ROLE_KEY','')
        self.bucket=bucket or os.getenv('SNAPSHOT_BUCKET','onicorn-snapshots')
        if not self.url or not self.key or not self.bucket: raise StorageError('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SNAPSHOT_BUCKET are required')
        self.opener=opener or urllib.request.urlopen
    def _request(self, method, path, data=None, content_type='application/octet-stream'):
        obj=safe_path(path); url=f'{self.url}/storage/v1/object/{self.bucket}/{obj}'
        req=urllib.request.Request(url,data=data,method=method,headers={'Authorization':f'Bearer {self.key}','apikey':self.key,'Content-Type':content_type,'x-upsert':'false'})
        try:
            with self.opener(req,timeout=30) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 409: raise StorageError('immutable object already exists') from e
            raise StorageError(f'storage request failed HTTP {e.code}') from e
    def upload_file(self, path: str, local: Path) -> dict:
        data=local.read_bytes(); digest=sha256_bytes(data); self._request('POST',path,data)
        return {'path':safe_path(path),'sha256':digest,'bytes':len(data)}
    def upload_json(self,path: str,value: dict) -> dict:
        data=(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode(); digest=sha256_bytes(data); self._request('POST',path,data,'application/json'); return {'path':safe_path(path),'sha256':digest,'bytes':len(data)}
    def download(self,path: str) -> bytes: return self._request('GET',path)
