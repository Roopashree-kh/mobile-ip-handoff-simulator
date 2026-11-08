"""Print agent telemetry in the terminal without the gateway (debugging aid).

Usage: python tools/telemetry_tail.py [--packets] [--kinds registration,handoff]
Binds the gateway telemetry port, so stop the gateway first.
"""
import argparse
import json
import os
import socket
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents"))
from mip import config  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--packets", action="store_true", help="also print router packet mirrors")
ap.add_argument("--kinds", help="comma separated event kinds to show")
ap.add_argument("--seconds", type=float, default=0, help="stop after this many seconds")
a = ap.parse_args()
topo = config.load()
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(topo.telemetry_addr())
s.settimeout(0.5)
kinds = set(a.kinds.split(",")) if a.kinds else None
end = time.time() + a.seconds if a.seconds else None
while end is None or time.time() < end:
    try:
        ev = json.loads(s.recvfrom(65535)[0])
    except socket.timeout:
        continue
    k = ev.get("kind")
    if k == "state" or (k in ("packet", "data_rx", "reply_rx") and not a.packets) or (kinds and k not in kinds):
        continue
    if k == "packet":
        print("%s PKT %-6s %s -> %s %s" % (time.strftime("%H:%M:%S"), ev.get("frm"), "", ev.get("to"), ev["summary"]))
    else:
        print("%s %-5s %-14s %s" % (time.strftime("%H:%M:%S"), ev["node"], k, ev["summary"]), flush=True)
