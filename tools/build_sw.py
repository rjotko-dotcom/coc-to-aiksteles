"""Sugeneruoja `web/sw.js` – sąrašą failų, kuriuos reikia turėti neprisijungus.

Paleisti po bet kokio `web/` pakeitimo:  python tools/build_sw.py
"""

from __future__ import annotations

import hashlib
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"
SKIP = {"sw.js"}
SKIP_DIRS = {"tests"}

TEMPLATE = """// Sugeneruota `tools/build_sw.py` – ranka nekeisti.
//
// Kad programa veiktų be interneto, visi failai (įskaitant atpažinimo variklį
// ir kalbos duomenis) įrašomi į naršyklės talpyklą iškart po pirmo atidarymo.

const VERSION = "{version}";
const ASSETS = [
{assets}
];

self.addEventListener("install", (event) => {{
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
}});

self.addEventListener("activate", (event) => {{
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
}});

// Antraštės, be kurių naršyklė neleidžia dirbti keliomis gijomis. Su jomis
// atpažinimas paleidžiamas lygiagrečiai ir trunka kelis kartus trumpiau.
function isolate(response) {{
  if (!response || !response.ok || response.type !== "basic") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {{
    status: response.status,
    statusText: response.statusText,
    headers,
  }});
}}

self.addEventListener("fetch", (event) => {{
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, {{ ignoreSearch: true }}).then((cached) => {{
      if (cached) return isolate(cached);
      return fetch(event.request).then((response) => {{
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {{
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }}
        return isolate(response);
      }}).catch(() => caches.match("./index.html").then(isolate));
    }}),
  );
}});
"""


def main() -> None:
    files = sorted(
        path for path in WEB.rglob("*")
        if path.is_file() and path.name not in SKIP and not path.name.startswith(".")
        and not SKIP_DIRS & set(path.relative_to(WEB).parts)
    )
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(WEB).as_posix().encode())
        digest.update(str(path.stat().st_size).encode())

    entries = ['  "./",', '  "./version.js",'] + [
        f'  "./{path.relative_to(WEB).as_posix()}",' for path in files
    ]
    (WEB / "sw.js").write_text(
        TEMPLATE.format(version=f"aikstele-{digest.hexdigest()[:12]}", assets="\n".join(entries)),
        encoding="utf-8",
    )
    version = f"aikstele-{digest.hexdigest()[:12]}"
    (WEB / "version.js").write_text(
        "// Sugeneruota `tools/build_sw.py` – ranka nekeisti.\n"
        f'export const VERSION = "{version}";\n',
        encoding="utf-8",
    )
    total = sum(path.stat().st_size for path in files)
    print(f"sw.js: {len(files)} failai, {total / 1024 / 1024:.1f} MB, versija {version}")


if __name__ == "__main__":
    main()
