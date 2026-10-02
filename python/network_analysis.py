#!/usr/bin/env python3
"""
network_analysis.py — NetworkX-based social network analysis for MetaCode.

Reads a JSON payload from stdin:
{
  "edges": [{"source": "...", "target": "...", "weight": 1}, ...],
  "labels": {"nodeId": "Display Label", ...},   // optional
  "directed": false
}

Writes exactly one line of JSON to stdout and nothing else, so the
calling Node process can safely JSON.parse it. Exit code is always 0;
failures are reported as {"error": "..."} rather than a stack trace.
"""

import sys
import json


def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(0)


try:
    import networkx as nx
except ImportError:
    fail("The 'networkx' Python package is not installed. Run: pip install -r requirements.txt")


def top_n(d, labels, n=15):
    items = sorted(d.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return [{"id": k, "label": labels.get(k, k), "value": round(float(v), 4)} for k, v in items]


def run(payload):
    edges_in = payload.get("edges", [])
    labels = payload.get("labels", {}) or {}
    directed = bool(payload.get("directed", False))

    if not isinstance(edges_in, list) or len(edges_in) == 0:
        fail("No edges provided.")

    G = nx.DiGraph() if directed else nx.Graph()

    skipped = 0
    for e in edges_in:
        if not isinstance(e, dict):
            skipped += 1
            continue
        s = e.get("source")
        t = e.get("target")
        if s is None or t is None or str(s).strip() == "" or str(t).strip() == "":
            skipped += 1
            continue
        s = str(s).strip()
        t = str(t).strip()
        if s == t:
            # skip self-loops — they add noise to centrality/clustering without
            # representing a real relationship between two distinct accounts
            skipped += 1
            continue

        w = e.get("weight")
        try:
            w = float(w) if w is not None and str(w).strip() != "" else 1.0
        except (ValueError, TypeError):
            w = 1.0

        if G.has_edge(s, t):
            G[s][t]["weight"] = G[s][t].get("weight", 1.0) + w
        else:
            G.add_edge(s, t, weight=w)

    n_nodes = G.number_of_nodes()
    n_edges = G.number_of_edges()

    if n_nodes == 0:
        fail("No valid edges could be built from the provided data — check the column mapping.")

    result = {
        "nodeCount": n_nodes,
        "edgeCount": n_edges,
        "skippedEdges": skipped,
        "directed": directed,
        "density": round(nx.density(G), 4)
    }

    degrees = dict(G.degree())
    result["avgDegree"] = round(sum(degrees.values()) / n_nodes, 2)

    # Connected components are only defined for undirected graphs
    UG = G.to_undirected() if directed else G
    components = list(nx.connected_components(UG))
    result["componentCount"] = len(components)
    result["largestComponentSize"] = max((len(c) for c in components), default=0)

    # Diameter/avg path length computed on the largest connected component only,
    # since these are undefined for disconnected graphs
    if components:
        largest = max(components, key=len)
        SG = UG.subgraph(largest).copy()
        if SG.number_of_nodes() > 1:
            try:
                result["diameter"] = nx.diameter(SG)
                result["avgPathLength"] = round(nx.average_shortest_path_length(SG), 3)
            except Exception:
                result["diameter"] = None
                result["avgPathLength"] = None
        else:
            result["diameter"] = 0
            result["avgPathLength"] = 0
    else:
        result["diameter"] = None
        result["avgPathLength"] = None

    try:
        result["avgClustering"] = round(nx.average_clustering(UG), 4)
    except Exception:
        result["avgClustering"] = None

    # Cap expensive centrality computations on large graphs to keep this fast
    LARGE_THRESHOLD = 500
    is_large = n_nodes > LARGE_THRESHOLD

    # Raw (untruncated) centrality dicts are kept around so we can build a
    # full per-node export table below, in addition to the top-15 view used
    # by the UI. node_id -> score for each measure; empty dict if skipped.
    degree_raw      = {}
    betweenness_raw = {}
    closeness_raw   = {}
    eigenvector_raw = {}

    try:
        degree_raw = nx.degree_centrality(G)
    except Exception:
        degree_raw = {}

    if not is_large:
        try:
            betweenness_raw = nx.betweenness_centrality(G, weight="weight")
        except Exception:
            betweenness_raw = {}
        try:
            closeness_raw = nx.closeness_centrality(G)
        except Exception:
            closeness_raw = {}
        try:
            eigenvector_raw = nx.eigenvector_centrality(G, max_iter=1000, weight="weight")
        except Exception:
            eigenvector_raw = {}
    else:
        try:
            k = min(100, n_nodes)
            betweenness_raw = nx.betweenness_centrality(G, k=k, weight="weight", seed=42)
        except Exception:
            betweenness_raw = {}
        result["note"] = (
            "Graph has over %d nodes \u2014 closeness/eigenvector centrality were skipped and "
            "betweenness was approximated by sampling, to keep analysis fast." % LARGE_THRESHOLD
        )

    result["centrality"] = {
        "degree":      top_n(degree_raw, labels),
        "betweenness": top_n(betweenness_raw, labels),
        "closeness":   top_n(closeness_raw, labels),
        "eigenvector": top_n(eigenvector_raw, labels)
    }

    # Community detection via greedy modularity — built into networkx core,
    # no extra dependencies (e.g. python-louvain) required
    node_to_community = {}
    try:
        communities = list(nx.algorithms.community.greedy_modularity_communities(UG, weight="weight"))
        for idx, comm in enumerate(communities):
            for node in comm:
                node_to_community[node] = idx
        result["communityCount"] = len(communities)
        result["communitySizes"] = [len(c) for c in communities]
        result["nodeCommunities"] = node_to_community
    except Exception:
        result["communityCount"] = None
        result["communitySizes"] = []
        result["nodeCommunities"] = {}

    # Full per-node table (every node, not just the top-15 shown in the UI) —
    # this is what CSV export uses so researchers get complete centrality
    # data rather than a truncated preview.
    node_table = []
    for node_id in G.nodes():
        node_table.append({
            "id": node_id,
            "label": labels.get(node_id, node_id),
            "community": node_to_community.get(node_id),
            "degree": round(float(degree_raw[node_id]), 4) if node_id in degree_raw else None,
            "betweenness": round(float(betweenness_raw[node_id]), 4) if node_id in betweenness_raw else None,
            "closeness": round(float(closeness_raw[node_id]), 4) if node_id in closeness_raw else None,
            "eigenvector": round(float(eigenvector_raw[node_id]), 4) if node_id in eigenvector_raw else None
        })
    node_table.sort(key=lambda x: x["degree"] if x["degree"] is not None else -1, reverse=True)
    result["nodeTable"] = node_table

    print(json.dumps(result))


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:
        fail("Could not parse input JSON: " + str(e))
        return

    try:
        run(payload)
    except SystemExit:
        raise
    except Exception as e:
        print(json.dumps({"error": "Unexpected error during analysis: " + str(e)}))


if __name__ == "__main__":
    main()
