#!/usr/bin/env bash
# patch_emerge.sh — Re-apply fixes to emerge-viz generated output.
#
# emerge-viz 2.0.7 has two bugs that are patched here:
#   1. NetworkX exports graph edges as "edges" but emerge_main.js reads "links"
#      (D3 force-graph convention). This causes:
#      "Uncaught TypeError: Cannot read properties of undefined (reading 'forEach')"
#   2. The Safari reload workaround uses `userAgent.includes('safari')` which
#      incorrectly matches Chrome (Chrome UA contains "Safari/..."). This causes
#      a "Unsafe attempt to load URL file://...#loaded" security warning and a
#      blank page on Chromium-based browsers.
#
# Run this after every: emerge -c emerge.yaml
# Or use the combined helper at the bottom of this file.

set -euo pipefail

EMERGE_JS="$(dirname "$0")/../docs/emerge/html/resources/js/emerge_main.js"
EMERGE_JS="$(realpath "$EMERGE_JS")"

if [[ ! -f "$EMERGE_JS" ]]; then
    echo "ERROR: $EMERGE_JS not found. Run 'emerge -c emerge.yaml' first."
    exit 1
fi

echo "Patching $EMERGE_JS ..."

# ── Fix 1: edges → links normalisation ──────────────────────────────────────
# Insert the normalisation line after the currentGraph assignment line.
# The sed pattern matches the exact line and appends three new lines after it.
if grep -q "FIX: NetworkX exports edges" "$EMERGE_JS"; then
    echo "  [skip] edges→links patch already applied."
else
    sed -i 's|currentGraph = JSON.parse(JSON.stringify(graphData\[graphType\]\['"'"'graph'"'"'\]))|currentGraph = JSON.parse(JSON.stringify(graphData[graphType]['"'"'graph'"'"']))\n    \/\/ FIX: NetworkX exports edges as "edges" (not "links" which D3 expects)\n    if (!currentGraph.links \&\& currentGraph.edges) {\n        currentGraph.links = currentGraph.edges;\n    }|' "$EMERGE_JS"
    echo "  [ok]   edges→links patch applied."
fi

# ── Fix 2: Safari UA check excludes Chrome/Chromium ─────────────────────────
if grep -q "userAgent.includes('chrome')" "$EMERGE_JS"; then
    echo "  [skip] Safari UA patch already applied."
else
    sed -i "s|if (userAgent.includes('safari')) {|if (userAgent.includes('safari') \&\& !userAgent.includes('chrome') \&\& !userAgent.includes('chromium')) {|" "$EMERGE_JS"
    echo "  [ok]   Safari UA patch applied."
fi

echo "Done. Starting HTTP server on http://127.0.0.1:7331 ..."
echo ""

# Kill any existing server on port 7331
fuser -k 7331/tcp 2>/dev/null || true

EMERGE_HTML_DIR="$(dirname "$0")/../docs/emerge/html"
EMERGE_HTML_DIR="$(realpath "$EMERGE_HTML_DIR")"

nohup python3 -c "
import http.server, os
os.chdir('${EMERGE_HTML_DIR}')
httpd = http.server.HTTPServer(('127.0.0.1', 7331), http.server.SimpleHTTPRequestHandler)
httpd.serve_forever()
" > /tmp/emerge_server.log 2>&1 &
echo $! > /tmp/emerge_server.pid

sleep 1
echo "Server running (PID $(cat /tmp/emerge_server.pid))"
echo ""
echo "  Open: http://127.0.0.1:7331/emerge.html"
echo ""
echo "  To stop: kill \$(cat /tmp/emerge_server.pid)"
