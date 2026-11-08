"""Send one JSON control command to an agent (debugging aid).

Usage: python tools/send_command.py MN handoff '{"link":"fa2"}'
       python tools/send_command.py ALL set '{"route_optimization":true}'
"""
import json
import os
import socket
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents"))
from mip import config  # noqa: E402

topo = config.load()
target, cmd = sys.argv[1], sys.argv[2]
args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for name in (topo.agent_names() if target == "ALL" else [target]):
    s.sendto(json.dumps({"cmd": cmd, "args": args}).encode(), topo.control_addr(name))
print("sent %s %s to %s" % (cmd, args, target))
