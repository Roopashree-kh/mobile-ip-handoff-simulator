"""Common runtime for every simulated network entity.

Threading model: two receiver threads (data socket and control socket) push items onto one
queue. A single event-loop thread drains the queue and runs timers, so all protocol state is
touched by exactly one thread and needs no locks.
"""
import heapq
import itertools
import json
import queue
import socket
import threading
import time

from . import clock
from . import config as cfgmod
from . import link
from .telemetry import Telemetry, disable_udp_connreset


class Timer:
    __slots__ = ("due", "fn", "args", "cancelled")

    def __init__(self, due, fn, args):
        self.due, self.fn, self.args, self.cancelled = due, fn, args, False

    def cancel(self):
        self.cancelled = True


class Node:
    STATE_INTERVAL = 0.5

    def __init__(self, name, topo=None):
        self.topo = topo or cfgmod.load()
        self.name = name
        self.ncfg = self.topo.node(name)
        self.node_id = self.ncfg["id"]
        self.mac = cfgmod.mac_for(self.node_id)
        self.features = dict(self.topo.defaults)
        self.tel = Telemetry(name, self.topo.telemetry_addr())
        self.sock = self._bind(self.ncfg["data_port"])
        self.ctl = self._bind(self.ncfg["control_port"])
        self.router = self.topo.data_addr("ROUTER")
        self.q = queue.Queue()
        self._timers = []
        self._seq = itertools.count()
        self._stop = False

    def _bind(self, port):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        disable_udp_connreset(s)
        s.bind((self.topo.host, port))
        return s

    # ---- timers ---------------------------------------------------------------
    def call_later(self, delay_s, fn, *args):
        t = Timer(clock.mono() + delay_s, fn, args)
        heapq.heappush(self._timers, (t.due, next(self._seq), t))
        return t

    def every(self, interval_fn, fn):
        """Run fn periodically. interval_fn returns the current interval in seconds."""
        def tick():
            fn()
            self.call_later(interval_fn(), tick)
        return self.call_later(interval_fn(), tick)

    # ---- sending --------------------------------------------------------------
    def send_raw(self, kind, payload, dst_id=0):
        try:
            self.sock.sendto(link.frame(kind, self.node_id, payload, dst_id), self.router)
        except OSError as e:
            self.tel.log("send failed: %s" % e)

    def send_routed(self, datagram):
        self.send_raw(link.ROUTED, datagram)

    def send_link(self, dst_node, datagram):
        dst_id = dst_node if isinstance(dst_node, int) else self.topo.node_id(dst_node)
        self.send_raw(link.LINK_UNICAST, datagram, dst_id)

    def send_broadcast(self, datagram):
        self.send_raw(link.LINK_BROADCAST, datagram)

    def send_arp(self, arp_bytes):
        self.send_raw(link.ARP, arp_bytes)

    # ---- receive loops --------------------------------------------------------
    def _rx(self, sock, tag):
        while not self._stop:
            try:
                data, addr = sock.recvfrom(65535)
            except (ConnectionResetError, OSError):
                if self._stop:
                    return
                continue
            self.q.put((tag, data, addr))

    def run(self):
        threading.Thread(target=self._rx, args=(self.sock, "frame"), daemon=True).start()
        threading.Thread(target=self._rx, args=(self.ctl, "ctl"), daemon=True).start()
        self.every(lambda: self.STATE_INTERVAL, self._emit_state)
        self.start()
        self.tel.emit("hello", "%s started" % self.name, role=self.ncfg["role"])
        try:
            while not self._stop:
                wait = 0.2
                if self._timers:
                    wait = max(0.0, min(wait, self._timers[0][0] - clock.mono()))
                try:
                    if wait > 0.02:
                        # Long wait: block on the queue. Windows rounds this to ~16 ms, which
                        # is harmless because no timer is due inside that window.
                        item = self.q.get(timeout=wait - 0.017)
                    else:
                        item = self.q.get_nowait()
                    self._dispatch(*item)
                    while True:  # drain whatever else has arrived
                        self._dispatch(*self.q.get_nowait())
                except queue.Empty:
                    if 0 < wait <= 0.02:
                        time.sleep(0.001)  # high-resolution sleep on Python 3.11+
                now = clock.mono()
                while self._timers and self._timers[0][0] <= now:
                    _, _, t = heapq.heappop(self._timers)
                    if not t.cancelled:
                        self._safe(t.fn, *t.args)
        except KeyboardInterrupt:
            pass
        finally:
            self._stop = True

    def _safe(self, fn, *args):
        try:
            fn(*args)
        except Exception as e:  # keep the agent alive and make the fault visible
            import traceback
            traceback.print_exc()
            self.tel.emit("error", "%s: %s" % (type(e).__name__, e))

    def _dispatch(self, tag, data, addr):
        if tag == "frame":
            fr = link.unframe(data)
            if fr is None:
                return
            kind, dst, src, payload = fr
            self._safe(self.on_frame, kind, src, payload)
        else:
            try:
                cmd = json.loads(data.decode())
            except ValueError:
                return
            self._safe(self._command, cmd)

    def _command(self, cmd):
        c = cmd.get("cmd")
        if c == "set":
            changed = {}
            for k, v in (cmd.get("args") or {}).items():
                if self.features.get(k) != v:
                    changed[k] = v
                self.features[k] = v
            if changed:
                self.on_features(changed)
        elif c == "ping_agent":
            self.tel.emit("hello", "%s alive" % self.name, role=self.ncfg["role"])
        else:
            self.on_command(c, cmd.get("args") or {})
        self._emit_state()

    def _emit_state(self):
        self.tel.state(self.snapshot())

    # ---- hooks for subclasses --------------------------------------------------
    def start(self):
        pass

    def on_frame(self, kind, src_id, payload):
        pass

    def on_command(self, cmd, args):
        pass

    def on_features(self, changed):
        pass

    def snapshot(self):
        return {}

    # ---- helpers --------------------------------------------------------------
    def reg_port(self):
        return self.topo.mip["reg_udp_port"]

    def now(self):
        return clock.now()

    def now_ms(self):
        return clock.now_ms()
