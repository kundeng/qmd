"""Turn the two bench.log files into one Markdown comparison table."""
import re, sys, pathlib

def parse(path):
    text = pathlib.Path(path).read_text()
    g = lambda pat, flags=0: (re.search(pat, text, flags) or [None, None])[1] if re.search(pat, text, flags) else None
    out = {}
    out["version"] = g(r"qmd --version: (.*)")
    out["add_docs_ms"] = g(r"collection add inv-docs: (\d+) ms")
    out["add_docs_counts"] = g(r"collection add inv-docs: \d+ ms \(exit \d+\) (Indexed: .*)")
    out["add_code_ms"] = g(r"collection add inv-code: (\d+) ms")
    out["add_code_counts"] = g(r"collection add inv-code: \d+ ms \(exit \d+\) (Indexed: .*)")
    out["embed_ms"] = g(r"\nembed: (\d+) ms")
    out["embed_summary"] = g(r"\nembed: \d+ ms \(exit \d+\) (.*)")
    out["total_docs"] = g(r"Total:\s+(\d+) files indexed")
    out["vectors"] = g(r"Vectors:\s+(\d+) embedded")
    out["session_ready"] = re.findall(r"session (\d) ready at \+(\d+) ms", text)
    m = re.search(r"\[3 sessions idle\] (\d+) qmd processes, RSS total (\d+) MB", text)
    out["idle_procs"], out["idle_rss"] = (m.group(1), m.group(2)) if m else (None, None)
    m = re.search(r"\[after queries \(models loaded\)\] (\d+) qmd processes, RSS total (\d+) MB", text)
    out["loaded_procs"], out["loaded_rss"] = (m.group(1), m.group(2)) if m else (None, None)
    out["idle_cpu"] = g(r"idle CPU over 60 s: ([\d.]+) CPU-seconds")
    out["idle_cpu_pct"] = g(r"\(([\d.]+)% of one core\)")
    out["lex"] = re.findall(r'lex "([^"]+)" run (\d): (\d+) ms, (\d+) results', text)
    out["query"] = re.findall(r'query "([^"]+)" run (\d): (\d+) ms, (\d+) results(.*)', text)
    out["live_search_ms"] = g(r"save → keyword-searchable \(live\): (\d+) ms")
    out["live_embed"] = g(r"save → embedded \(live[^)]*\): (.*)")
    out["stock_update_ms"] = g(r"qmd update took (\d+) ms")
    out["stock_embed_ms"] = g(r"qmd embed for the new file took (\d+) ms")
    out["stock_found"] = g(r"session finds the file: (\w+)")
    out["after_close"] = g(r"after sessions closed: (.*)")
    out["procs_idle_lines"] = re.search(r"\[3 sessions idle\][^\n]*\n((?:   .*\n)+)", text)
    return out

stock, fork = parse(sys.argv[1]), parse(sys.argv[2])
def lat(rows, which):
    r = [int(x[2]) for x in rows]
    return f"{r[0]} / {min(r[1:]) if len(r) > 1 else '-'}" if r else "-"
rows = [
 ("qmd version / entry", stock["version"], fork["version"]),
 ("Index docs collection (84 md files)", f'{stock["add_docs_ms"]} ms', f'{fork["add_docs_ms"]} ms'),
 ("Index code collection", f'{stock["add_code_ms"]} ms ({stock["add_code_counts"]})', f'{fork["add_code_ms"]} ms ({fork["add_code_counts"]})'),
 ("Embed everything (cold)", f'{stock["embed_ms"]} ms', f'{fork["embed_ms"]} ms'),
 ("Documents / vectors after indexing", f'{stock["total_docs"]} / {stock["vectors"]}', f'{fork["total_docs"]} / {fork["vectors"]}'),
 ("Three MCP sessions ready (ms after start)", ", ".join(f"#{s} {ms}" for s, ms in stock["session_ready"]), ", ".join(f"#{s} {ms}" for s, ms in fork["session_ready"])),
 ("Processes with three sessions open, idle", stock["idle_procs"], fork["idle_procs"]),
 ("RSS total, three sessions idle", f'{stock["idle_rss"]} MB', f'{fork["idle_rss"]} MB'),
 ("RSS total after queries (models loaded)", f'{stock["loaded_rss"]} MB ({stock["loaded_procs"]} proc.)', f'{fork["loaded_rss"]} MB ({fork["loaded_procs"]} proc.)'),
 ("Idle CPU, 60 s, all qmd processes", f'{stock["idle_cpu"]} s ({stock["idle_cpu_pct"]}% of a core)', f'{fork["idle_cpu"]} s ({fork["idle_cpu_pct"]}% of a core)'),
 ("BM25 query latency, first / best of next (ms)", lat(stock["lex"][:3], 0), lat(fork["lex"][:3], 0)),
 ("Full query (expand + rerank), first / best of next (ms)", lat(stock["query"], 0), lat(fork["query"], 0)),
 ("Save → keyword-searchable", f'never until `qmd update`; update took {stock["stock_update_ms"]} ms, embed {stock["stock_embed_ms"]} ms', f'{fork["live_search_ms"]} ms'),
 ("Save → embedded", "after a manual `qmd embed`", fork["live_embed"] or "-"),
 ("After all sessions close", "every server exits with its host", fork["after_close"] or "-"),
]
print("| Measure | Stock qmd 2.8.3 | Fork (`live/main`) |\n|---|---|---|")
for name, a, b in rows:
    print(f"| {name} | {a} | {b} |")
print("\nQuery runs (ms):")
for label, d in (("stock", stock), ("fork", fork)):
    print(f"- {label} lex: " + ", ".join(f'"{q}" #{r} {ms} ms ({n} res)' for q, r, ms, n in d["lex"]))
    print(f"- {label} query: " + ", ".join(f'#{r} {ms} ms ({n} res){e}' for q, r, ms, n, e in d["query"]))
for label, d in (("stock", stock), ("fork", fork)):
    if d["procs_idle_lines"]:
        print(f"\nProcesses with three sessions idle ({label}): pid ppid rss_kb %cpu command")
        print("```\n" + d["procs_idle_lines"].group(1).rstrip() + "\n```")
