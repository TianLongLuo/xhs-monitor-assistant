import unittest
import tempfile
from pathlib import Path
from server import MonitorStore
from link_import import parse_links, import_links, list_links, complete_link

ID = 'a' * 24
URL = 'https://www.xiaohongshu.com/explore/' + ID


class LinkImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.store = MonitorStore(root / 'test.db', root / 'exports')

    def test_share_text_and_query_token_retained(self):
        notes, bad, dup = parse_links('分享 ' + URL + '?xsec_token=abc&xsec_source=pc_share。\n' + URL)
        self.assertEqual(notes, [(ID, URL + '?xsec_token=abc&xsec_source=pc_share')])
        self.assertEqual((bad, dup), ([], 1))

    def test_invalid_hosts_short_links_and_paths(self):
        for url in ['https://xhslink.com/a/abc', 'https://www.xiaohongshu.com.evil.test/explore/' + ID,
                    'https://user@www.xiaohongshu.com/explore/' + ID, URL + '/more',
                    'https://www.xiaohongshu.com/user/profile/' + ID]:
            self.assertEqual(parse_links(url)[0], [])
        with self.assertRaises(ValueError): parse_links('hello')
        with self.assertRaises(ValueError): parse_links((URL + '\n') * 501)

    def test_queue_is_persistent_idempotent_and_does_not_create_fake_note(self):
        self.assertEqual(import_links(self.store, {'text': URL})['added'], 1)
        self.assertEqual(import_links(self.store, {'text': URL})['existing'], 1)
        self.assertEqual(len(list_links(self.store)['notes']), 1)
        self.assertTrue(list_links(self.store)['notes'][0]['needsInitialPull'])
        self.assertEqual(self.store.list_notes(), [])
        complete_link(self.store, {'noteId': ID})
        self.assertEqual(len(list_links(self.store)['notes']), 1)
        other = MonitorStore(self.store.db_path, self.store.export_dir)
        self.assertEqual(len(list_links(other)['notes']), 1)

    def test_ignored_and_deleted_never_reenabled(self):
        import_links(self.store, {'text': URL})
        with self.store._session() as db:
            db.execute("INSERT INTO notes(note_id,url,title,first_seen_at,last_seen_at,status,source) VALUES (?,?,?,?,?,?,?)",
                       (ID, URL, 'original', 'now', 'now', 'ignored', 'dom'))
        self.assertEqual(list_links(self.store)['notes'], [])
        self.assertEqual(import_links(self.store, {'text': URL})['ignored'], 1)

    def test_already_pulled_uses_sync_and_completion_removes_queue(self):
        import_links(self.store, {'text': URL})
        with self.store._session() as db:
            db.execute("INSERT INTO notes(note_id,url,title,first_seen_at,last_seen_at,status,source,pull_status) VALUES (?,?,?,?,?,?,?,?)",
                       (ID, URL, 'original', 'now', 'now', 'known', 'dom', 'synced'))
        self.assertFalse(list_links(self.store)['notes'][0]['needsInitialPull'])
        complete_link(self.store, {'noteId': ID})
        self.assertEqual(list_links(self.store)['notes'], [])
