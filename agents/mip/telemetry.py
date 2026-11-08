"""Fire-and-forget JSON telemetry to the Node gateway over localhost UDP.

Every event has: ts (ms since epoch), node, kind, summary. Packet events from the router add
layers (decoded protocol tree) and hex (raw IPv4 datagram). Optional fields:
  rfc    the RFC section that explains the step (used by Learn mode)
  learn  one or two sentences for the Learn mode tooltip
"""
import json
import socket
import sys
import time


def disable_udp_connreset(sock):
    """On Windows an ICMP port-unreachable makes the next recvfrom raise WSAECONNRESET.
    The gateway or a peer may simply not be running yet, so switch that behaviour off."""
    if sys.platform == "win32" and hasattr(socket, "SIO_UDP_CONNRESET"):
        try:
            sock.ioctl(socket.SIO_UDP_CONNRESET, False)
        except OSError:
            pass


class Telemetry:
    def __init__(self, node, addr, echo=True):
        self.node = node
        self.addr = addr
        self.echo = echo
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        disable_udp_connreset(self.sock)

    def emit(self, kind, summary, **fields):
        ev = {"ts": round(time.time() * 1000, 3), "node": self.node, "kind": kind, "summary": summary}
        ev.update(fields)
        try:
            data = json.dumps(ev, separators=(",", ":"), default=str).encode()
            if len(data) > 60000:
                ev.pop("layers", None)
                data = json.dumps(ev, separators=(",", ":"), default=str).encode()
            self.sock.sendto(data, self.addr)
        except OSError:
            pass
        if self.echo and kind not in ("packet", "state", "data_rx"):
            print("[%s] %s: %s" % (time.strftime("%H:%M:%S"), kind, summary), flush=True)

    def log(self, summary, **fields):
        self.emit("log", summary, **fields)

    def state(self, snapshot):
        self.emit("state", "state", state=snapshot)
