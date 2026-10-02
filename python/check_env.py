#!/usr/bin/env python3
"""Quick check for whether NetworkX is installed and importable.
Prints exactly one line of JSON: {"ok": true, "version": "..."} or
{"ok": false, "error": "..."}."""

import json

try:
    import networkx as nx
    print(json.dumps({"ok": True, "version": nx.__version__}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
