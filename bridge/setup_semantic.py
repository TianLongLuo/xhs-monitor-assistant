"""Run with the Python that has requirements-semantic.txt installed.

Downloads only pinned public model files. No user content leaves this machine.
"""
from pathlib import Path
import json
import sys
import urllib.request

REVISION = '7999e1d3359715c523056ef9478215996d62a620'


def main():
    import torch
    import transformers
    import numpy
    root = Path(__file__).resolve().parent
    target = root / 'models' / 'bge-small-zh-v1.5'
    target.mkdir(parents=True, exist_ok=True)
    for name in ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt']:
        destination = target / name
        if not destination.exists():
            print('Downloading', name, flush=True)
            temporary = destination.with_suffix(destination.suffix + '.part')
            with urllib.request.urlopen(f'https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/{REVISION}/{name}', timeout=120) as response:
                with temporary.open('wb') as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
            temporary.replace(destination)
    (target / 'revision.txt').write_text(REVISION, encoding='utf-8')
    # Validate model before marking the runtime installed.
    transformers.AutoTokenizer.from_pretrained(target, local_files_only=True)
    transformers.AutoModel.from_pretrained(target, local_files_only=True)
    (root / 'semantic_runtime.json').write_text(json.dumps({'python': sys.executable}, indent=2), encoding='utf-8')
    print('Offline semantic retrieval installed.')


if __name__ == '__main__':
    main()
