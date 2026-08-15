"""Static file server for the playground.

Browsers refuse to load Web Workers and fetch() wasm from file://, so dist/
has to be served over HTTP. Sends COOP/COEP so the page is cross-origin
isolated (SharedArrayBuffer available).
"""

import argparse
import http.server
import mimetypes
import os
import socketserver
import sys

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/x-tar", ".tar")

# clang/lld/memfs are extensionless wasm binaries.
EXTENSIONLESS_WASM = {"clang", "lld", "memfs"}


class HtmlHandler(http.server.BaseHTTPRequestHandler):
    html_dir = None

    @classmethod
    def set_configuration(cls, html_dir):
        cls.html_dir = os.path.abspath(html_dir)

    def guess_type(self, path):
        name = os.path.basename(path)
        if name in EXTENSIONLESS_WASM:
            return "application/wasm"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def send_binary_file(self, path, body=True):
        candidate = os.path.abspath(os.path.join(self.html_dir, path))
        if not candidate.startswith(self.html_dir) or not os.path.isfile(candidate):
            self.send_error(404)
            return
        with open(candidate, "rb") as handle:
            data = handle.read()
        self.send_response(200)
        self.send_header("Content-type", self.guess_type(candidate))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if body:
            self.wfile.write(data)

    def do_GET(self):
        self.serve(body=True)

    def do_HEAD(self):
        # Same headers, no body - health checks and curl -I use this.
        self.serve(body=False)

    def serve(self, body):
        path = self.path.split("?", 1)[0]
        if path in ("/exit", "/exit/"):
            self.send_response(200)
            self.end_headers()
            self.server.shutdown()
            sys.exit()
        elif path == "/":
            self.send_binary_file("index.html", body)
        else:
            self.send_binary_file(path.lstrip("/"), body)

    def log_message(self, fmt, *args):
        if self.server.verbose:
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, *args, verbose=False, **kwargs):
        self.verbose = verbose
        super().__init__(*args, **kwargs)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(prog="serve", description="Serve the built playground")
    parser.add_argument("-r", "--resources_dir", default=os.path.join(here, "dist"),
                        help="directory to serve (default: dist/)")
    parser.add_argument("-p", "--port", type=int, default=8080, help="port (default: 8080)")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every request")
    args = parser.parse_args()

    root = os.path.abspath(args.resources_dir)
    if not os.path.isfile(os.path.join(root, "index.html")):
        sys.exit(f"{root} has no index.html - run 'python tools/build.py' to create it")

    missing = [a for a in ("clang.wasm.gz", "wasm-ld.wasm.gz", "sysroot.tar.gz")
               if not os.path.isfile(os.path.join(root, "vendor", a))]
    if missing:
        print(f"warning: {root}/vendor is missing {', '.join(missing)}; the page will "
              "load but cannot compile. See the README on building the toolchain.",
              file=sys.stderr)

    HtmlHandler.set_configuration(root)
    with Server(("", args.port), HtmlHandler, verbose=args.verbose) as httpd:
        print(f"serving {root} at http://localhost:{args.port}/  (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
