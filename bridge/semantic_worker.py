"""Offline BGE encoder. Private stdin/stdout protocol; never opens a network port."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    # Keep heavy ML imports OUT of the native-host executable.
    import numpy as np
    import torch
    from transformers import AutoModel, AutoTokenizer
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    root = Path(__file__).resolve().parent
    model_path = root / 'models' / 'bge-small-zh-v1.5'
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
    model = AutoModel.from_pretrained(model_path, local_files_only=True).eval()
    revision = (model_path / 'revision.txt').read_text().strip()
    cache = sqlite3.connect(sys.argv[1])
    cache.execute('CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector BLOB NOT NULL)')
    query_cache = {}

    def encode(texts):
        batches = []
        with torch.inference_mode():
            for start in range(0, len(texts), 32):
                tokens = tokenizer(texts[start:start+32], padding=True, truncation=True, max_length=512, return_tensors='pt')
                vectors = model(**tokens).last_hidden_state[:, 0]
                batches.append(torch.nn.functional.normalize(vectors, p=2, dim=1).cpu().numpy().astype('<f4'))
        return np.concatenate(batches) if batches else np.empty((0, model.config.hidden_size), dtype='<f4')

    for line in sys.stdin:
        try:
            request = json.loads(line)
            texts = request['texts']
            keys = [hashlib.sha256((revision + '\0' + value).encode()).hexdigest() for value in texts]
            vectors, missing = {}, {}
            for key, value in zip(keys, texts):
                if key in vectors or key in missing:
                    continue
                row = cache.execute('SELECT vector FROM embeddings WHERE key=?', (key,)).fetchone()
                vector = np.frombuffer(row[0], dtype='<f4') if row else None
                if vector is not None and vector.shape == (model.config.hidden_size,) and np.isfinite(vector).all():
                    vectors[key] = vector
                else:
                    missing[key] = value
            if missing:
                pending = list(missing)
                for start in range(0, len(pending), 32):
                    batch = pending[start:start+32]
                    for key, vector in zip(batch, encode([missing[k] for k in batch])):
                        vectors[key] = vector
                        cache.execute('INSERT OR REPLACE INTO embeddings VALUES (?,?)', (key, vector.tobytes()))
                    # Interrupted first-time builds resume from completed batches.
                    cache.commit()
            query = request['query']
            if query not in query_cache:
                if len(query_cache) >= 64:
                    query_cache.clear()
                query_cache[query] = encode(['为这个句子生成表示以用于检索相关文章：' + query])[0]
            scores = np.stack([vectors[k] for k in keys]) @ query_cache[query] if keys else []
            result = {'ok': True, 'scores': [float(v) for v in scores], 'encoded': len(missing)}
        except Exception as exc:
            cache.rollback()
            result = {'ok': False, 'error': str(exc)}
        print(json.dumps(result, ensure_ascii=False), flush=True)
    cache.close()


if __name__ == '__main__':
    main()
