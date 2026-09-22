"""Persistent explicit link queue; importing never invents note content."""
import re
from urllib.parse import urlsplit


def parse_links(value):
    if not isinstance(value, str) or len(value) > 200000:
        raise ValueError("请输入链接文本，最多 200000 字符")
    urls = re.findall(r'https?://[^\s<>"\u3000]+', value)
    if len(urls) > 500:
        raise ValueError("每次最多导入 500 个链接")
    notes, rejected, seen, duplicates = [], [], set(), 0
    for raw in urls:
        url = raw.rstrip("，。；！、）)]}.,;!'")
        try:
            parsed = urlsplit(url)
            match = re.fullmatch(r'/(?:explore|discovery/item)/([a-fA-F0-9]{24})/?', parsed.path)
            valid = (parsed.scheme == 'https' and parsed.hostname in {'xiaohongshu.com', 'www.xiaohongshu.com'}
                     and not parsed.username and not parsed.password and parsed.port in (None, 443)
                     and match and len(url) <= 2000)
        except ValueError:
            valid = False
        if not valid:
            rejected.append(url)
            continue
        note_id = match[1].lower()
        if note_id in seen:
            duplicates += 1
            continue
        seen.add(note_id)
        notes.append((note_id, url))
    if not urls:
        raise ValueError("没有找到链接；请粘贴 https://www.xiaohongshu.com/explore/ 开头的完整帖子链接")
    return notes, rejected, duplicates


def import_links(store, payload):
    notes, rejected, duplicates = parse_links(payload.get('text'))
    added = existing = ignored = 0
    with store.pull_lock, store.lock, store._session() as db:
        for note_id, url in notes:
            note = db.execute('SELECT status,is_deleted FROM notes WHERE note_id=?', (note_id,)).fetchone()
            if note and (note['status'] == 'ignored' or note['is_deleted']):
                ignored += 1
                continue
            if db.execute('SELECT 1 FROM imported_links WHERE note_id=?', (note_id,)).fetchone():
                existing += 1
                continue
            db.execute('INSERT INTO imported_links(note_id,url) VALUES (?,?)', (note_id, url))
            added += 1
    return dict(ok=True, added=added, existing=existing, ignored=ignored,
                duplicates=duplicates, rejected=rejected)


def list_links(store):
    with store.lock, store._session() as db:
        rows = db.execute("""SELECT i.note_id,i.url,n.pull_status,n.source FROM imported_links i
            LEFT JOIN notes n ON n.note_id=i.note_id
            WHERE n.note_id IS NULL OR (n.status<>'ignored' AND n.is_deleted=0)
            ORDER BY i.rowid""").fetchall()
    return dict(ok=True, notes=[dict(noteId=r['note_id'], url=r['url'], source='imported_link',
                                   needsInitialPull=r['source'] != 'existing_xlsx' and r['pull_status'] not in ('synced', 'partial'),
                                   title='导入帖子 ' + r['note_id']) for r in rows])


def complete_link(store, payload):
    with store.pull_lock, store.lock, store._session() as db:
        db.execute("""DELETE FROM imported_links WHERE note_id=? AND EXISTS
            (SELECT 1 FROM notes n WHERE n.note_id=imported_links.note_id
             AND (n.source='existing_xlsx' OR n.pull_status IN ('synced','partial')))""",
                   (str(payload.get('noteId') or ''),))
    return dict(ok=True)
