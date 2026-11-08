"""Start the whole simulator with one command and stop it cleanly with Ctrl+C.

    python run_all.py            agents + gateway + Vite dev server (http://localhost:5173)
    python run_all.py --prod     builds the dashboard once, the gateway serves it (http://localhost:8080)
    python run_all.py --no-ui    agents + gateway only

Every child's output is prefixed with its name in its own colour. All ports come from
config/topology.json. Nothing needs administrator rights.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
WIN = os.name == "nt"
COLOURS = ["36", "35", "33", "93", "32", "34", "96", "91", "92", "95"]


def enable_ansi():
    if WIN:
        os.system("")  # switches the Windows console into VT mode so ANSI colours work


def npm():
    return shutil.which("npm.cmd" if WIN else "npm") or "npm"


def ensure_node_modules(folder, label):
    if os.path.isdir(os.path.join(folder, "node_modules")):
        return
    print("[run_all] %s: node_modules missing, running npm install (one time)..." % label, flush=True)
    subprocess.run([npm(), "install", "--no-audit", "--no-fund"], cwd=folder, check=True)


class Child:
    def __init__(self, name, cmd, cwd, colour):
        self.name, self.cmd, self.cwd, self.colour = name, cmd, cwd, colour
        self.proc = None

    def start(self):
        env = dict(os.environ, PYTHONUNBUFFERED="1", FORCE_COLOR="0")
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if WIN else 0
        self.proc = subprocess.Popen(self.cmd, cwd=self.cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, env=env, creationflags=flags,
                                     start_new_session=not WIN, text=True, encoding="utf-8", errors="replace",
                                     bufsize=1)
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        tag = "\x1b[%sm%-8s\x1b[0m|" % (self.colour, self.name)
        for line in self.proc.stdout:
            sys.stdout.write("%s %s" % (tag, line if line.endswith("\n") else line + "\n"))
            sys.stdout.flush()

    def stop(self):
        if not self.proc or self.proc.poll() is not None:
            return
        if WIN:
            # /T takes the whole tree, which matters for node and its children
            subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def main():
    ap = argparse.ArgumentParser(description="Start every simulator process")
    ap.add_argument("--prod", action="store_true", help="build the dashboard and serve it from the gateway")
    ap.add_argument("--no-ui", action="store_true", help="do not start the Vite dev server")
    a = ap.parse_args()
    if sys.version_info < (3, 10):
        sys.exit("Python 3.10 or newer is required (found %s)" % sys.version.split()[0])
    if not shutil.which("node"):
        sys.exit("Node.js 18 or newer is required and must be on PATH")
    enable_ansi()
    topo = json.load(open(os.path.join(ROOT, "config", "topology.json"), encoding="utf-8"))
    gw_dir = os.path.join(ROOT, "gateway")
    fe_dir = os.path.join(ROOT, "frontend")
    ensure_node_modules(gw_dir, "gateway")
    if not a.no_ui:
        ensure_node_modules(fe_dir, "frontend")
    if a.prod:
        print("[run_all] building the dashboard...", flush=True)
        subprocess.run(["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "build"], cwd=fe_dir, check=True)

    py = sys.executable
    ag = os.path.join(ROOT, "agents")
    plan = [("ROUTER", [py, os.path.join(ag, "core_router.py")]),
            ("HA", [py, os.path.join(ag, "home_agent.py")])]
    for fa in ("FA-1", "FA-2", "FA-3"):
        n = topo["nodes"][fa]
        plan.append((fa, [py, os.path.join(ag, "foreign_agent.py"), "--id", fa,
                          "--subnet", topo["links"][n["link"]]["prefix"], "--port", str(n["data_port"])]))
    plan += [("MN", [py, os.path.join(ag, "mobile_node.py")]),
             ("CN", [py, os.path.join(ag, "correspondent.py")]),
             ("GATEWAY", ["node", "server.js"])]
    if not a.no_ui and not a.prod:
        plan.append(("VITE", ["node", os.path.join("node_modules", "vite", "bin", "vite.js")]))

    children = []
    for i, (name, cmd) in enumerate(plan):
        cwd = gw_dir if name == "GATEWAY" else fe_dir if name == "VITE" else ROOT
        c = Child(name, cmd, cwd, COLOURS[i % len(COLOURS)])
        c.start()
        children.append(c)
        time.sleep(0.25)

    url = "http://localhost:%d" % (topo["gateway"]["http_port"] if a.prod else topo["frontend"]["dev_port"])
    print("\n[run_all] %d processes running." % len(children))
    if not a.no_ui:
        print("[run_all] Open the console at %s" % url)
    print("[run_all] pcap export: http://localhost:%d/export.pcap" % topo["gateway"]["http_port"])
    print("[run_all] Press Ctrl+C to stop everything.\n", flush=True)

    stopping = threading.Event()

    def shutdown(*_):
        stopping.set()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    if WIN:
        signal.signal(signal.SIGBREAK, shutdown)
    reported = set()
    while not stopping.is_set():
        for c in children:
            if c.proc.poll() is not None and c.name not in reported:
                reported.add(c.name)
                print("[run_all] WARNING: %s exited with code %s" % (c.name, c.proc.returncode), flush=True)
        stopping.wait(0.5)
    print("\n[run_all] stopping...", flush=True)
    for c in reversed(children):
        c.stop()
    print("[run_all] all processes stopped.", flush=True)


if __name__ == "__main__":
    main()
