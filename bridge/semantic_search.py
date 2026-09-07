"""Snapshot-scoped semantic retrieval with a separately cached offline encoder.

Business SQLite/CSV data is never modified. Results are evidence, not sentiment
classifications. Missing dependencies fail explicitly, never silently use LIKE.
"""
from __future__ import annotations

import atexit
import json
import math
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading

MODEL = 'BAAI/bge-small-zh-v1.5'
PRESETS = {
    '差评': '消费者对产品或服务不满意，投诉、踩雷、后悔购买、体验差、退款困难',
    '强硬销售': '销售强迫购买、纠缠推销，不买不让走，拒绝后仍施压、诱导办卡充值',
    '价格差异': '同款产品线上线下价格不同，门店比网上贵，买贵了，价差、差价、价格不透明',
    '过敏': '使用产品后皮肤过敏，发红、发痒、红肿、刺痛、起疹子或烂脸',
}


class LocalEncoder:
    def __init__(self, cache_path):
        self.cache_path = Path(cache_path)
        self.process = None
        self.lock = threading.Lock()
        atexit.register(self.close)

    def close(self):
        process, self.process = self.process, None
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def scores(self, texts, query):
        with self.lock:
            if self.process is None or self.process.poll() is not None:
                root = Path(sys.executable).resolve().parent.parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
                config_file = root / 'semantic_runtime.json'
                if not config_file.exists():
                    raise ValueError('语义检索尚未安装：请运行 bridge/setup_semantic.py 配置本地模型与 Python')
                config = json.loads(config_file.read_text(encoding='utf-8'))
                python = config.get('python', '')
                if not python or not Path(python).is_file():
                    raise ValueError('语义检索 Python 路径失效，请重新运行 setup_semantic.py')
                self.cache_path.parent.mkdir(parents=True, exist_ok=True)
                self.process = subprocess.Popen(
                    [python, '-u', str(root / 'semantic_worker.py'), str(self.cache_path)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
            process = self.process
            response = queue.Queue(maxsize=1)
            def read():
                try:
                    process.stdin.write(json.dumps({'texts': texts, 'query': query}, ensure_ascii=False) + '\n')
                    process.stdin.flush()
                    response.put(process.stdout.readline())
                except Exception as exc:
                    response.put(exc)
            threading.Thread(target=read, daemon=True).start()
            try:
                line = response.get(timeout=240)
                if isinstance(line, Exception):
                    raise line
                if not line:
                    raise ValueError('本地向量模型启动失败；请检查模型文件及 requirements-semantic.txt 依赖')
                result = json.loads(line)
                if not result.get('ok'):
                    raise ValueError('本地语义检索失败：' + str(result.get('error', '未知错误')))
                scores = result['scores']
                if len(scores) != len(texts) or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in scores):
                    raise ValueError('本地向量返回了无效分数')
                return scores
            except queue.Empty:
                self.close()
                raise ValueError('语义索引建立超时，请稍后重试；已完成的向量会复用') from None
            except Exception:
                self.close()
                raise


def retrieve(db, encoder, dataset, base, where, parameters, query, minimum=0.5, limit=200):
    """Filter first, rank all eligible chunks, deduplicate records, then paginate upstream."""
    query = str(query).strip()
    if not query or len(query) > 500:
        raise ValueError('请输入 1–500 字的语义检索描述')
    minimum = float(minimum)
    if not math.isfinite(minimum) or not 0 <= minimum <= 1:
        raise ValueError('相关度阈值必须在 0–1 之间')
    limit = max(1, min(int(limit), 2000))
    docs = []
    def add(record_id, content, comment_id='', deleted=False, sentiment='', negative=False):
        content = str(content or '').strip()
        # Chunk so evidence late in long posts/comments is not truncated away.
        for start in range(0, len(content), 300):
            chunk = content[start:start+360]
            if chunk:
                docs.append((record_id, chunk, comment_id, deleted, sentiment, negative))
            if start + 360 >= len(content):
                break
    if dataset == 'comments':
        for row in db.execute(f'SELECT c.comment_id,c.content,c.is_deleted,c.sentiment,(c.is_negative=1 OR c.manual_negative=1 OR c.analysis_is_negative=\'是\') FROM {base}{where}', parameters):
            add(row[0], row[1], row[0], bool(row[2]), row[3], bool(row[4]))
    else:
        for row in db.execute(f'SELECT n.note_id,n.title,n.content,n.post_sentiment,(n.is_negative=1 OR n.manual_negative=1 OR n.analysis_is_negative=\'是\') FROM {base}{where}', parameters):
            add(row[0], '\n'.join(str(x or '') for x in row[1:3]), sentiment=row[3], negative=bool(row[4]))
        # Reuse the same filter scope, with no fixed top-N prefilter.
        for row in db.execute(f'SELECT sc.note_id,sc.content,sc.comment_id,sc.is_deleted,sc.sentiment,(sc.is_negative=1 OR sc.manual_negative=1 OR sc.analysis_is_negative=\'是\') FROM comments sc JOIN (SELECT n.note_id FROM {base}{where}) eligible ON eligible.note_id=sc.note_id', parameters):
            add(row[0], row[1], row[2], bool(row[3]), row[4], bool(row[5]))
    if not docs:
        return [], {}
    texts = [d[1] for d in docs]
    # Broad complaints cover several distinct semantic clusters. Use the best
    # cosine across facets rather than one vague query that favors neutral text.
    queries = [PRESETS.get(query, query)]
    if query == '差评':
        queries += [PRESETS[k] for k in ('强硬销售', '价格差异', '过敏')]
        queries += ['东西很难用，效果差，后悔买了，要求退款却被拒绝，服务态度恶劣']
    score_sets = [encoder.scores(texts, q) for q in queries]
    scores = [max(values) for values in zip(*score_sets)]
    ranked = {}
    for (record_id, evidence, comment_id, deleted, sentiment, negative), cosine in zip(docs, scores):
        score = cosine
        reason = '中文向量相似度'
        if query in PRESETS:
            # Reuse existing judgments only; retrieval never writes sentiment.
            # Preserve raw cosine separately: the displayed score is NOT a
            # calibrated probability or a claim that an adverse event occurred.
            if negative and query == '差评':
                score += 0.10
                reason += '；已有负面标注优先'
            elif sentiment == 'positive':
                score -= 0.18
                reason += '；已有正面标注降权'
            elif sentiment == 'neutral' and query == '差评':
                score -= 0.10
                reason += '；已有中性标注降权'
            if query in ('差评', '过敏') and re.search(r'(?:以前|之前).{0,16}(?:某大牌|别的|别家|其他品牌).{0,12}过敏', evidence):
                # Explicit cross-product contrast is topical but weak evidence
                # for an adverse experience with the currently discussed item.
                if re.search(r'现在|没翻车|舒服|清爽|不油|不糊', evidence) and not re.search(r'(?:这款|这个|现在|这次).{0,8}(?:也过敏|红肿|红痒|起疹)', evidence):
                    score -= 0.20
                    reason += '；其他产品过敏经历与当前体验对比降权'
        # Only suppress unambiguous denial-only allergy statements. Mixed
        # experiences ("以前不过敏，但这次红痒") remain eligible for human review.
        if query in ('过敏', '差评') and re.search(r'(?:没有|没|并不|不|不会|从未|未)(?:出现|发生)?过敏', evidence):
            remainder = re.sub(r'(?:没有|没|并不|不|不会|从未|未)(?:出现|发生)?过敏', '', evidence)
            if not re.search(r'红|痒|肿|疹|刺痛|烂脸|但是|不过|但|贵|强迫|强制|退[款货]|不让走|难用|差劲', remainder):
                continue
        if score >= minimum and (record_id not in ranked or score > ranked[record_id]['_semantic_score']):
            ranked[record_id] = {
                '_semantic_score': round(max(0.0, min(1.0, score)), 6),
                '_semantic_cosine': round(cosine, 6), '_semantic_reason': reason,
                '_semantic_evidence': evidence, '_semantic_comment_id': comment_id,
                '_semantic_evidence_status': ('已删除评论' if deleted else '评论') if comment_id else '帖子正文',
            }
    ids = sorted(ranked, key=lambda key: (-ranked[key]['_semantic_score'], key))[:limit]
    return ids, {key: ranked[key] for key in ids}
