import unittest
from automation.report_batch.storage import safe_path, sha256_bytes
class StorageTests(unittest.TestCase):
 def test_path_traversal_rejected(self):
  for p in ('../x','a/../../x','/x','a//x','a/./x','a/é'):
   with self.assertRaises(ValueError): safe_path(p)
 def test_checksum(self): self.assertEqual(len(sha256_bytes(b'x')),64)
if __name__=='__main__': unittest.main()
