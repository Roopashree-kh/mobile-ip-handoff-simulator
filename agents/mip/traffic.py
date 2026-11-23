"""Traffic sources run by the correspondent: voice, video and chat.

voice  G.711-like. A packet every 20 ms, a 160-byte payload, 50 packets per second.
video  A frame every 1/fps seconds. A larger key frame every second. Each frame is split into
       packets of at most max_packet_payload bytes. The adaptive sender can step the picture
       down to a lower rate and quality and back up (config/traffic.json, levels).
chat   A short message every few seconds. The receiver acknowledges each one. The sender
       retransmits with a growing timeout until the acknowledgement arrives or it gives up.

Every packet starts with the 28-byte flow header from qos.py, which carries the send time the
receiver uses to measure one-way delay. The sources only build and schedule packets. Sending
goes through the correspondent so route optimization keeps working.
"""
import math
import random

from . import clock, qos


class Ticker:
    """Periodic call on the node's event loop that does not drift and does not burst after a stall."""

    def __init__(self, node, fn):
        self.node, self.fn = node, fn
        self.timer = None
        self.running = False
        self.interval_fn = None
        self.due = 0.0

    def start(self, interval_fn):
        self.stop()
        self.interval_fn = interval_fn
        self.running = True
        self.due = clock.mono()
        self._fire()

    def _fire(self):
        if not self.running:
            return
        self.fn()
        if not self.running:
            return
        now = clock.mono()
        self.due += self.interval_fn()
        if self.due < now - 0.25:
            self.due = now
        self.timer = self.node.call_later(max(0.0, self.due - now), self._fire)

    def stop(self):
        self.running = False
        if self.timer:
            self.timer.cancel()
            self.timer = None


class VoiceSource:
    name = "voice"

    def __init__(self, cn, fcfg):
        self.cn, self.cfg = cn, fcfg
        self.ticker = Ticker(cn, self.tick)
        self.reset()

    def reset(self):
        self.seq = 0
        self.sent = 0

    def start(self):
        self.ticker.start(lambda: self.cfg["packet_interval_ms"] / 1000.0)

    def stop(self):
        self.ticker.stop()

    def tick(self):
        self.cn.send_flow(self.cfg, qos.T_VOICE, 0, self.seq, self.cfg["packet_interval_ms"],
                          body=bytes(self.cfg["payload_bytes"]))
        self.seq += 1
        self.sent += 1

    def snapshot(self):
        return {"running": self.ticker.running, "sent": self.sent, "interval_ms": self.cfg["packet_interval_ms"],
                "payload_bytes": self.cfg["payload_bytes"]}


class VideoSource:
    name = "video"

    def __init__(self, cn, fcfg, acfg):
        self.cn, self.cfg, self.acfg = cn, fcfg, acfg
        self.levels = fcfg["levels"]
        self.rng = random.Random(7)
        self.ticker = Ticker(cn, self.tick)
        self.watch = Ticker(cn, self.check)
        self.reset()

    def reset(self):
        self.level = int(self.cfg.get("start_level", 0))
        self.frame = 0
        self.seq = 0
        self.sent = 0
        self.bytes = 0
        self.last_key = None
        self.last_change = 0.0
        self.last_fb = None
        self.good_since = None
        self.changes = 0

    def start(self):
        self.last_fb = None
        self.ticker.start(lambda: 1.0 / self.levels[self.level]["fps"])
        self.watch.start(lambda: 0.25)

    def stop(self):
        self.ticker.stop()
        self.watch.stop()

    def tick(self):
        lv = self.levels[self.level]
        now = clock.mono()
        key = self.last_key is None or now - self.last_key >= self.cfg["key_frame_every_s"] - 0.5 / lv["fps"]
        if key:
            self.last_key = now
        size = lv["key_bytes"] if key else lv["delta_bytes"]
        size = int(size * (1 + self.rng.uniform(-1, 1) * self.cfg["size_jitter_pct"] / 100.0))
        cnt = max(1, int(math.ceil(size / float(self.cfg["max_packet_payload"]))))
        each = max(1, size // cnt)
        for i in range(cnt):
            self.cn.send_flow(self.cfg, qos.T_VIDEO, qos.F_KEY if key else 0, self.seq, 1000.0 / lv["fps"],
                              frame_id=self.frame, frag_idx=i, frag_cnt=cnt, body=bytes(each))
            self.seq += 1
            self.sent += 1
            self.bytes += each
        self.frame += 1

    # ---- adaptive sender (feature adaptive_sender) -------------------------------------
    def on_feedback(self, loss_pct, signal_dbm, now):
        """The mobile node reports loss and signal. Step down fast, step up slowly."""
        self.last_fb = now
        a = self.acfg
        if not self.cn.features.get("adaptive_sender"):
            return
        bad = loss_pct >= a["down_loss_pct"] or (signal_dbm is not None and signal_dbm < a["weak_signal_dbm"])
        good = loss_pct <= a["up_loss_pct"] and (signal_dbm is None or signal_dbm >= a["weak_signal_dbm"])
        if bad:
            self.good_since = None
            if self.level < len(self.levels) - 1 and now - self.last_change >= a["down_dwell_ms"] / 1000.0:
                self._move(+1, now, "loss %.1f%%, signal %s dBm" % (loss_pct, signal_dbm))
        elif good:
            if self.good_since is None:
                self.good_since = now
            if self.level > 0 and now - self.good_since >= a["up_dwell_ms"] / 1000.0 and \
                    now - self.last_change >= a["up_dwell_ms"] / 1000.0:
                self._move(-1, now, "loss %.1f%%, signal ok" % loss_pct)
                self.good_since = now

    def check(self):
        """No feedback for feedback_timeout_ms means the mobile node cannot be heard: assume the worst."""
        if not self.cn.features.get("adaptive_sender"):
            if self.level != int(self.cfg.get("start_level", 0)):
                self._move(int(self.cfg.get("start_level", 0)) - self.level, clock.mono(), "adaptive sender switched off")
            return
        now = clock.mono()
        if self.last_fb is not None and now - self.last_fb > self.acfg["feedback_timeout_ms"] / 1000.0 \
                and self.level < len(self.levels) - 1 and now - self.last_change >= 1.0:
            self._move(+1, now, "no feedback for %.1f s" % (now - self.last_fb))
            self.good_since = None

    def _move(self, step, now, why):
        old = self.level
        self.level = max(0, min(len(self.levels) - 1, self.level + step))
        if self.level == old:
            return
        self.last_change = now
        self.changes += 1
        lv = self.levels[self.level]
        self.cn.tel.emit("adapt", "CN video %s: %s level %s (%d fps, key frame %d bytes), %s" % (
            "lowered" if step > 0 else "restored", "now", lv["name"], lv["fps"], lv["key_bytes"], why),
            level=lv["name"], fps=lv["fps"], direction="down" if step > 0 else "up",
            learn="The correspondent adapts the video to what the mobile node reports. When loss rises or the signal "
                  "is weak it sends fewer and smaller frames, and it restores the picture once the path is healthy.")

    def snapshot(self):
        lv = self.levels[self.level]
        return {"running": self.ticker.running, "sent": self.sent, "level": lv["name"], "fps": lv["fps"],
                "key_bytes": lv["key_bytes"], "frames": self.frame, "changes": self.changes,
                "kbps": None}


class TextSource:
    name = "text"

    def __init__(self, cn, fcfg):
        self.cn, self.cfg = cn, fcfg
        self.rng = random.Random(11)
        self.timer = None
        self.running = False
        self.scan = Ticker(cn, self.retry)
        self.reset()

    def reset(self):
        self.next_id = 0
        self.pending = {}        # id -> {ts, tries, due, body}
        self.sent = self.acked = self.failed = self.retx = 0
        self.rtts = []

    def start(self):
        self.running = True
        self._schedule()
        self.scan.start(lambda: 0.1)

    def stop(self):
        self.running = False
        if self.timer:
            self.timer.cancel()
        self.scan.stop()

    def _schedule(self):
        if not self.running:
            return
        lo, hi = self.cfg["message_every_s"]
        self.timer = self.cn.call_later(self.rng.uniform(lo, hi), self._new)

    def _new(self):
        if not self.running:
            return
        n = self.rng.randint(*self.cfg["message_bytes"])
        mid = self.next_id
        self.next_id += 1
        now = self.cn.now_ms()
        self.pending[mid] = {"ts": now, "tries": 0, "due": clock.mono() + self.cfg["ack_timeout_ms"] / 1000.0,
                             "len": n}
        self.sent += 1
        self._send(mid, False)
        self._schedule()

    def _send(self, mid, retx):
        p = self.pending[mid]
        head = ("%d,%d," % (self.sent, self.failed)).encode()
        body = head + (b"chat message %d " % mid) * 20
        body = body[:max(len(head) + 4, p["len"])]
        self.cn.send_flow(self.cfg, qos.T_TEXT, qos.F_RETX if retx else 0, mid, 0, ts_ms=p["ts"], body=body)

    def retry(self):
        now = clock.mono()
        for mid in list(self.pending):
            p = self.pending[mid]
            if now < p["due"]:
                continue
            if p["tries"] >= self.cfg["max_retries"]:
                del self.pending[mid]
                self.failed += 1
                self.cn.tel.emit("text", "CN gives up on chat message %d after %d retransmissions" % (mid, p["tries"]),
                                 id=mid, failed=True)
                continue
            p["tries"] += 1
            self.retx += 1
            back = min(self.cfg["ack_timeout_ms"] * (2 ** p["tries"]), self.cfg["ack_timeout_max_ms"]) / 1000.0
            p["due"] = now + back
            self._send(mid, True)

    def on_ack(self, mid, ts_ms):
        p = self.pending.pop(mid, None)
        if p:
            self.acked += 1
            self.rtts.append(self.cn.now_ms() - p["ts"])
            del self.rtts[:-200]

    def snapshot(self):
        r = self.rtts
        return {"running": self.running, "sent": self.sent, "acked": self.acked, "failed": self.failed,
                "retransmissions": self.retx, "pending": len(self.pending),
                "ack_time_ms": round(sum(r) / len(r), 1) if r else None}
