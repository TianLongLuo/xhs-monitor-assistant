"""External agent semantic publication. No model calls; all writes use store locks."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

FIELDS = ('semantic_analysis_count', 'analysis_is_negative', 'negative_type', 'negative_subtype')
HEADERS = ('语义分析次数', '分析结论是否差评', '差评类型', '差评子类型')
SOURCE = ('note_id', 'comment_id', 'title', 'content', 'author', 'tags', 'parent_comment_id',
          'first_seen_at', 'is_deleted', 'deleted_at', 'post_status', 'comment_status')


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(encoded(value).encode('utf-8')).hexdigest()


def init_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS external_analysis_batches (
        batch_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL, audit_json TEXT NOT NULL, created_at TEXT NOT NULL)''')


def committed(store, batch_id):
    with store._session() as db:
        return db.execute('SELECT 1 FROM external_analysis_batches WHERE batch_id=?', (batch_id,)).fetchone() is not None


def source(row):
    return {key: row.get(key) for key in SOURCE if key in row}


def eligible(note, row):
    return bool(note and not note.get('is_deleted') and not row.get('is_deleted')
                and note.get('post_status') != '已删除' and row.get('comment_status') != '已删除'
                and note.get('status') != 'ignored'
                and (note.get('source') == 'existing_xlsx' or note.get('pull_status') in ('synced', 'partial')
                     or note.get('status') == 'confirmed'))


def item_for(db, kind, target_id):
    table, key = ('notes', 'note_id') if kind == 'note' else ('comments', 'comment_id')
    found = db.execute(f'SELECT * FROM {table} WHERE {key}=?', (target_id,)).fetchone()
    if found is None:
        raise ValueError('分析对象不存在')
    row = dict(found)
    found_note = db.execute('SELECT * FROM notes WHERE note_id=?', (row['note_id'],)).fetchone()
    note = dict(found_note) if found_note else {}
    parent = None
    if kind == 'comment' and row.get('parent_comment_id'):
        parent = db.execute('SELECT * FROM comments WHERE comment_id=? AND note_id=?',
                            (row['parent_comment_id'], row['note_id'])).fetchone()
    context = {'source': source(row), 'noteContext': source(note),
               'parentContext': source(dict(parent)) if parent else {}}
    revision = {key: row.get(key) for key in (*FIELDS, 'manual_negative', 'review_status', 'last_ai_analyzed_at')}
    return {'targetType': kind, 'targetId': target_id, 'noteId': row['note_id'], **context,
            'sourceHash': digest(context), 'analysisRevision': digest(revision)}, row, note


def analysis_mode(payload):
    mode = payload.get('mode', 'analyze')
    if mode not in ('analyze', 'fillMissingCategories'):
        raise ValueError('mode 必须为 analyze 或 fillMissingCategories')
    return mode


def pending(store, payload):
    mode = analysis_mode(payload)
    limit = payload.get('limit', 25)
    if type(limit) is not int or not 1 <= limit <= 25:
        raise ValueError('limit 必须为 1–25 的整数')
    items, total, excluded, review, invalid = [], 0, 0, 0, 0
    selected_note = None
    with store.pull_lock, store.lock, store._session() as db:
        notes = {r['note_id']: dict(r) for r in db.execute('SELECT * FROM notes ORDER BY note_id')}
        for kind, rows in (('note', list(notes.values())),
                           ('comment', db.execute('SELECT * FROM comments ORDER BY note_id,comment_id'))):
            for raw in rows:
                row = dict(raw)
                note = notes.get(row['note_id'], {})
                if not eligible(note, row):
                    excluded += 1
                    continue
                raw_conclusion = row.get('analysis_is_negative') or ''
                conclusion = str(raw_conclusion).strip()
                if conclusion and raw_conclusion not in ('是', '否', '待复核'):
                    invalid += 1
                    continue
                review += int(conclusion == '待复核')
                if mode == 'fillMissingCategories':
                    if conclusion not in ('是', '否', '待复核') or all(str(row.get(k) or '').strip() for k in ('negative_type', 'negative_subtype')):
                        continue
                elif conclusion:
                    continue
                total += 1
                if selected_note is None:
                    selected_note = row['note_id']
                if row['note_id'] == selected_note and len(items) < limit:
                    key = 'note_id' if kind == 'note' else 'comment_id'
                    item = item_for(db, kind, row[key])[0]
                    if mode == 'fillMissingCategories':
                        item['currentAnalysis'] = dict(zip(('analysisIsNegative', 'negativeType', 'negativeSubtype'),
                                                          (row.get(k) or '' for k in FIELDS[1:])))
                    items.append(item)
    return {'ok': True, 'protocolVersion': 1, 'classificationPolicyVersion': 2, 'mode': mode,
            'batchId': str(uuid.uuid4()), 'items': items,
            'pendingCount': total, 'excludedCount': excluded, 'needsReviewCount': review, 'invalidConclusionCount': invalid}


def batch_id(payload):
    value = payload.get('batchId')
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', value):
        raise ValueError('batchId 格式无效')
    return value


def status(store, payload):
    bid = batch_id(payload)
    with store.lock, store._session() as db:
        row = db.execute('SELECT receipt_json FROM external_analysis_batches WHERE batch_id=?', (bid,)).fetchone()
    return json.loads(row[0]) if row else {'ok': True, 'batchId': bid, 'status': 'not_found'}


def assert_material_ids(store, note_id, media_dir):
    if not media_dir or not Path(media_dir).is_dir():
        raise ValueError('素材目录缺失，请先完成帖子采集')
    folder = Path(media_dir)
    note = json.loads((folder / 'note.json').read_text(encoding='utf-8-sig'))
    comments = json.loads((folder / 'comments.json').read_text(encoding='utf-8-sig'))
    if note.get('noteId') != note_id or not isinstance(comments, list):
        raise ValueError('素材快照归属无效')
    ids = [r.get('commentId') for r in comments]
    with store._session() as db:
        expected = {r[0] for r in db.execute('SELECT comment_id FROM comments WHERE note_id=?', (note_id,))}
    if len(ids) != len(set(ids)) or set(ids) != expected:
        raise ValueError('素材快照评论 ID 集合不一致')


def verify(store, payload):
    bid = batch_id(payload)
    with store.pull_lock, store.lock:
        with store._session() as db:
            found = db.execute('SELECT * FROM external_analysis_batches WHERE batch_id=?', (bid,)).fetchone()
            if not found:
                raise ValueError('未找到已提交批次')
            receipt, audit = json.loads(found['receipt_json']), json.loads(found['audit_json'])
            note = db.execute('SELECT * FROM notes WHERE note_id=?', (receipt['noteId'],)).fetchone()
            if not note:
                raise ValueError('帖子已不存在；历史提交成功不等于当前数据未变化')
            for entry in audit['items']:
                item, row, _ = item_for(db, entry['targetType'], entry['targetId'])
                if [row[k] for k in FIELDS] != entry['after'] or item['sourceHash'] != entry['sourceHash']:
                    raise ValueError('批次提交后数据已有变化，请重新导出检查；不要重放覆盖')
        store._verify_note_store_consistency(receipt['noteId'], note['media_dir'], verify_fields=True)
        assert_material_ids(store, receipt['noteId'], note['media_dir'])
        return {**receipt, 'verified': True, 'verificationTime': datetime.now(timezone.utc).isoformat()}


def submit(store, payload):
    mode = analysis_mode(payload)
    bid = batch_id(payload)
    request_hash = digest(payload)
    entries = payload.get('items')
    if not isinstance(entries, list) or not 1 <= len(entries) <= 25:
        raise ValueError('每批需要 1–25 个分析结果')
    for key in ('agent', 'model'):
        if not isinstance(payload.get(key), str) or not 1 <= len(payload[key].strip()) <= 200:
            raise ValueError(f'{key} 必填；未知时填写 unknown')
    with store.pull_lock, store.lock:
        with store._session() as db:
            old = db.execute('SELECT * FROM external_analysis_batches WHERE batch_id=?', (bid,)).fetchone()
            if old:
                if old['request_hash'] != request_hash:
                    raise ValueError('batchId 已用于不同内容，禁止覆盖已提交批次')
                return json.loads(old['receipt_json'])
        if not store._persistent_checkpoints_recovered or not store.seed_xlsx_path:
            raise ValueError('服务尚未完成 CSV 配置与恢复')
        if list((store.export_dir / '.sync_checkpoints').glob('*/checkpoint.json')):
            raise ValueError('存在未清理同步检查点，请先重启服务完成恢复')
        prepared, seen, note_ids = [], set(), set()
        with store._session() as db:
            for entry in entries:
                if not isinstance(entry, dict) or entry.get('targetType') not in ('note', 'comment'):
                    raise ValueError('targetType 无效')
                kind, tid = entry['targetType'], entry.get('targetId')
                if not isinstance(tid, str) or not tid or len(tid) > 256 or (kind, tid) in seen:
                    raise ValueError('对象 ID 无效或重复')
                seen.add((kind, tid))
                item, row, note = item_for(db, kind, tid)
                existing = str(row['analysis_is_negative'] or '').strip()
                if not eligible(note, row):
                    raise ValueError('对象已删除或忽略；禁止覆盖')
                if mode == 'fillMissingCategories':
                    if row['analysis_is_negative'] not in ('是', '否', '待复核') or all(str(row.get(k) or '').strip() for k in ('negative_type', 'negative_subtype')):
                        raise ValueError('补齐模式只处理已有结论且分类缺项的对象；禁止覆盖')
                elif existing:
                    raise ValueError('对象已有结论；禁止覆盖')
                if any(entry.get(key) != item[key] for key in ('noteId', 'sourceHash', 'analysisRevision')):
                    raise ValueError('分析期间原文、上下文或结论已变化，请重新导出并分析')
                value = entry.get('analysisIsNegative')
                if value not in ('是', '否', '待复核'):
                    raise ValueError('analysisIsNegative 必须是 是/否/待复核')
                for key, maximum in (('negativeType', 1000), ('negativeSubtype', 2000), ('reason', 8000)):
                    if not isinstance(entry.get(key), str) or len(entry[key]) > maximum:
                        raise ValueError(f'{key} 缺失或超长')
                if not all(entry[k].strip() for k in ('reason', 'negativeType', 'negativeSubtype')):
                    raise ValueError('必须提供判断理由、类型和子类型；信息不足应明确填写待复核及缺失信息')
                if mode == 'fillMissingCategories':
                    if value != row['analysis_is_negative']:
                        raise ValueError('补齐分类不得修改原语义结论')
                    for incoming, stored in (('negativeType', 'negative_type'), ('negativeSubtype', 'negative_subtype')):
                        if str(row.get(stored) or '').strip() and entry[incoming] != row[stored]:
                            raise ValueError('补齐分类不得覆盖已有类型或子类型')
                evidence = entry.get('evidence')
                texts = [str(v or '') for section in ('source', 'noteContext', 'parentContext')
                         for k, v in item[section].items() if k in ('title', 'content')]
                if not isinstance(evidence, list) or len(evidence) > 20 or any(
                    not isinstance(e, str) or not e.strip() or not any(e in t for t in texts) for e in evidence
                ) or (value != '待复核' and not evidence):
                    raise ValueError('evidence 必须为原文/上下文中的逐字摘录；信息不足可待复核')
                after = [int(row['semantic_analysis_count'] or 0) + 1, value,
                         entry['negativeType'], entry['negativeSubtype']]
                prepared.append({**entry, 'before': [row[k] for k in FIELDS], 'after': after})
                note_ids.add(note['note_id'])
                media_dir = note['media_dir']
        if len(note_ids) != 1:
            raise ValueError('每批只允许同一个帖子及其评论')
        note_id = next(iter(note_ids))
        store._verify_note_store_consistency(note_id, media_dir, verify_fields=True)
        assert_material_ids(store, note_id, media_dir)
        checkpoint = None
        try:
            with store._session() as db:
                # Recheck inside the actual write transaction. A foreign change
                # before this point must be rejected, not overwritten by an old
                # prepared value or restored away by checkpoint rollback.
                db.execute('BEGIN IMMEDIATE')
                for entry in prepared:
                    current, current_row, current_note = item_for(db, entry['targetType'], entry['targetId'])
                    if (not eligible(current_note, current_row)
                        or any(entry[k] != current[k] for k in ('noteId', 'sourceHash', 'analysisRevision'))
                        or [current_row[k] for k in FIELDS] != entry['before']):
                        raise ValueError('提交前数据已变化，请重新导出；未覆盖其他写入')
                checkpoint = store._capture_sync_checkpoint(note_id)
                checkpoint['externalAnalysisBatch'] = bid
                store._persist_sync_checkpoint(checkpoint)
                for entry in prepared:
                    table, key = ('notes', 'note_id') if entry['targetType'] == 'note' else ('comments', 'comment_id')
                    db.execute(f'UPDATE {table} SET semantic_analysis_count=?,analysis_is_negative=?,negative_type=?,negative_subtype=? WHERE {key}=?',
                               (*entry['after'], entry['targetId']))
            notes_path, comments_path = store._csv_paths()
            nh, nr = store._read_csv_table(notes_path, [])
            ch, cr = store._read_csv_table(comments_path, [])
            for header in HEADERS:
                if header not in nh or header not in ch:
                    raise ValueError('CSV 缺少语义分析字段')
            mapping = {(e['targetType'], e['targetId']): e['after'] for e in prepared}
            matched = set()
            for kind, rows, id_header in (('note', nr, '笔记ID'), ('comment', cr, '笔记评论ID')):
                for row in rows:
                    identity = (kind, row.get(id_header))
                    if identity in mapping:
                        if identity in matched:
                            raise ValueError('CSV 对象重复')
                        matched.add(identity)
                        row.update(dict(zip(HEADERS, mapping[identity])))
            if matched != set(mapping):
                raise ValueError('CSV 缺少分析对象')
            store._replace_csv_pair(nh, nr, ch, cr, 'agent-analysis')
            store._refresh_material_snapshot_for_note(note_id)
            store._verify_note_store_consistency(note_id, media_dir, verify_fields=True)
            assert_material_ids(store, note_id, media_dir)
            receipt = {'ok': True, 'protocolVersion': 1, 'batchId': bid, 'noteId': note_id,
                       'status': 'committed', 'updatedCount': len(prepared), 'verified': True,
                       'classificationPolicyVersion': 2, 'mode': mode,
                       'committedAt': datetime.now(timezone.utc).isoformat()}
            with store._session() as db:
                db.execute('INSERT INTO external_analysis_batches VALUES(?,?,?,?,?)',
                           (bid, request_hash, encoded(receipt),
                            encoded({'agent': payload['agent'], 'model': payload['model'], 'items': prepared}),
                            receipt['committedAt']))
        except Exception:
            if checkpoint is None:
                raise
            failures = store._rollback_sync_checkpoints([checkpoint])
            if failures:
                raise RuntimeError('分析写入回滚未完成，请先恢复：' + '；'.join(failures))
            raise
        # A committed marker is durable before cleanup. Cleanup failure must never rollback.
        try:
            store._discard_sync_checkpoint(checkpoint)
        except Exception:
            pass
        store._data_overview_approved_tokens.clear()
        return receipt


def handle(store, operation, payload):
    if not isinstance(payload, dict):
        raise ValueError('请求必须是 JSON 对象')
    handlers = {'pending': pending, 'submit': submit, 'status': status, 'verify': verify}
    if operation not in handlers:
        raise ValueError('未知 Agent 操作')
    return handlers[operation](store, payload)
