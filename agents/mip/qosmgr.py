"""The mobile node's QoS manager: owns one monitor per flow, answers the flow packets (chat
acknowledgements), reports to the dashboard twice a second and sends the feedback the
correspondent's adaptive sender listens to.

Telemetry produced (all from the mobile node):
  qos_point    compact numbers every report interval, the source of the charts and the CSV
  qos_event    an interruption, or an outage and how long each flow took to recover
  qos_run      the end-of-run summary, requested with the qos_summary command
The full report with the compliance checks is in the node's state snapshot (snapshot()["qos"]).
"""
import struct

from . import ipv4, qos


class QosManager:
    def __init__(self, mn, topo):
        self.mn = mn
        self.topo = topo
        self.t = topo.extra("traffic.json")
        self.tc = topo.extra("qos_targets.json")
        fl = self.t["flows"]
        ws = self.t["window_s"]
        self.interval_ms = self.t["report_interval_ms"]
        self.fcfg = fl
        self.voice = qos.SeqFlow("voice", fl["voice"], self.tc, ws)
        self.video = qos.VideoFlow("video", fl["video"], self.tc, ws)
        self.text = qos.TextFlow(fl["text"], self.tc, ws)
        self.by_port = {fl["voice"]["mn_port"]: self.voice, fl["video"]["mn_port"]: self.video,
                        fl["text"]["mn_port"]: self.text}
        self.fb = self.t["feedback"]
        self.window_ms = ws * 1000.0
        self.reset()

    def reset(self):
        for f in (self.voice, self.video, self.text):
            f.reset()
        self.cn_ip = None
        self.signal = None
        self.blackout = False
        self.clear_after = 0.0
        self.outages = []
        self.cur = None
        self.last = None
        self.fb_seq = 0
        self.handoffs = 0
        self.run_start = None

    def ports(self):
        return set(self.by_port)

    def note_handoff(self):
        """Count handoffs that happen while a run is going, not the attach that Reset does."""
        if self.run_start is not None:
            self.handoffs += 1

    # ---- packets -------------------------------------------------------------------------
    def on_packet(self, dport, h, data, link):
        flow = self.by_port.get(dport)
        pk = qos.unpack(data)
        if flow is None or pk is None:
            return
        arr = self.mn.now_ms()
        self.cn_ip = h.src
        if self.run_start is None:
            self.run_start = arr
        if flow is self.text:
            r = flow.on_message(pk, arr, link)
            self._ack(pk, h)
            if r["new"]:
                self.mn.tel.emit("chat_rx", "chat message %d delivered in %.0f ms%s" % (
                    r["id"], r["delivery_ms"], " (after retransmission)" if r["retx"] else ""),
                    id=r["id"], delivery_ms=round(r["delivery_ms"], 1), retx=r["retx"])
            self._note_rx("text", arr)
            return
        info = flow.on_packet(pk, arr, link)
        if info is None:
            return
        self._note_rx(flow.kind, arr)
        iv = info["interruption"]
        if iv:
            if any(o["start"] <= iv["end_ms"] and (o["end"] or 1e18) >= iv["start_ms"] for o in self._all_outages()):
                iv["cause"] = "blackout"
            hid = self.mn.handoff["id"] if self.mn.handoff else 0
            self.mn.tel.emit("qos_event", "%s interruption %.0f ms (%s)" % (flow.kind, iv["ms"], iv["cause"]),
                             type="interruption", handoff_id=hid, **{k: v for k, v in iv.items()})

    def _ack(self, pk, h):
        f = self.fcfg["text"]
        body = qos.pack(f["flow_id"], qos.T_ACK, 0, 0, pk["seq"], pk["ts"], 0)
        self.mn.send_out(ipv4.build_udp_datagram(self.mn.home, h.src, f["mn_port"], f["cn_port"], body))

    # ---- outages ---------------------------------------------------------------------------
    def _all_outages(self):
        return self.outages + ([self.cur] if self.cur else [])

    def outage_start(self, now):
        if self.cur:
            return
        self.blackout = True
        self.cur = {"start": now, "end": None, "first_rx": {}, "link": self.mn.link}
        self.mn.tel.emit("qos_event", "all networks lost: outage starts", type="outage_start", link=self.mn.link)

    def outage_end(self, now):
        if not self.cur or self.cur["end"]:
            return
        self.cur["end"] = now
        self.blackout = False
        self.clear_after = now + self.window_ms
        self.cur["link_after"] = self.mn.link

    def _note_rx(self, flow, arr):
        c = self.cur
        if c and c["end"] and flow not in c["first_rx"] and arr >= c["end"]:
            c["first_rx"][flow] = arr
            self._maybe_close(arr)

    def _maybe_close(self, now, force=False):
        c = self.cur
        if not c or not c["end"]:
            return
        active = [k for k, f in (("voice", self.voice), ("video", self.video), ("text", self.text))
                  if getattr(f, "last_arr", None) is not None or (k == "text" and f.msgs)]
        if not force and not all(k in c["first_rx"] for k in active):
            return
        rec = {k: round(c["first_rx"][k] - c["end"], 1) if k in c["first_rx"] else None for k in ("voice", "video", "text")}
        c["recover_ms"] = rec
        c["duration_ms"] = round(c["end"] - c["start"], 1)
        self.outages.append(c)
        self.cur = None
        self.mn.tel.emit("qos_event", "outage of %.1f s over: voice back after %s, video after %s, chat after %s" % (
            c["duration_ms"] / 1000.0, _ms(rec["voice"]), _ms(rec["video"]), _ms(rec["text"])),
            type="outage", duration_ms=c["duration_ms"], recover_ms=rec, link=c.get("link_after"))

    # ---- periodic ----------------------------------------------------------------------------
    def tick(self):
        now = self.mn.now_ms()
        self.video.tick(now)
        c = self.cur
        if c and c["end"] and now - c["end"] > 20000:
            self._maybe_close(now, force=True)

    def report(self):
        now = self.mn.now_ms()
        clear = not self.blackout and now >= self.clear_after
        v = self.voice.report(now, self.interval_ms, clear)
        vi = self.video.report(now, self.interval_ms, clear)
        tx = self.text.report(now, self.interval_ms, clear)
        self.last = {"t": round(now, 1), "link": self.mn.link, "signal": self.signal, "blackout": self.blackout,
                     "voice": v, "video": vi, "text": tx}
        if not (v["active"] or vi["active"] or tx["active"]):
            return
        # flows that have been silent for a long time outside an outage have simply been stopped:
        # keep the timeline and the CSV free of the tail of 100 per cent loss that would follow
        silent = min((f["stall_ms"] for f in (v, vi) if f["active"]), default=0)
        if silent > self.tc.get("idle_after_ms", 8000) and not self.blackout:
            return
        hid = self.mn.handoff["id"] if self.mn.handoff else 0
        vw, iw = v["window"], vi["window"]
        self.mn.tel.emit("qos_point", "qos", t=round(now, 1), link=self.mn.link, signal=self.signal, blackout=self.blackout,
                         handoff_id=hid,
                         voice={"delay": _r(vw["delay_mean"]), "p95": _r(vw["delay_p95"]), "max": _r(vw["delay_max"]),
                                "jitter": _r(self.voice.jitter), "loss": _r(vw["loss_pct"]), "mos": v.get("mos"),
                                "r": v.get("r"), "m2e": v.get("ta_ms"), "buffer": _r(v.get("buffer_ms")),
                                "level": v["verdict"]["level"], "stall": v["stall_ms"]},
                         video={"delay": _r(iw["delay_mean"]), "p95": _r(iw["delay_p95"]), "max": _r(iw["delay_max"]),
                                "jitter": _r(self.video.jitter), "loss": _r(iw["loss_pct"]),
                                "freeze_ms": vi["freeze_ms"], "freezes": vi["freezes"], "frozen": vi["frozen_now"],
                                "frames_lost": vi["frames_lost"], "buffer": _r(vi.get("buffer_ms")),
                                "level": vi["verdict"]["level"], "stall": vi["stall_ms"]},
                         text={"delivered": tx["delivered"], "last": tx["last_delivery_ms"], "waiting": tx["waiting"],
                               "level": tx["verdict"]["level"]})

    def feedback(self):
        """Loss and signal report to the correspondent, over the same path as the other replies."""
        if not self.cn_ip or self.voice.last_arr is None and self.video.last_arr is None:
            return
        now = self.mn.now_ms()
        vloss = self.video.window_stats(now)["loss_pct"] or 0.0
        aloss = self.voice.window_stats(now)["loss_pct"] or 0.0
        sig = int(round(self.signal * 10)) if self.signal is not None else -32768
        self.fb_seq += 1
        body = b"MIPF" + struct.pack("!IhHHB", self.fb_seq, sig, int(vloss * 100), int(aloss * 100), 0)
        self.mn.send_out(ipv4.build_udp_datagram(self.mn.home, self.cn_ip, self.fb["mn_port"], self.fb["cn_port"], body))

    # ---- run summary ---------------------------------------------------------------------------
    def summary(self, label):
        now = self.mn.now_ms()
        self.report()
        v, vi, tx = self.last["voice"], self.last["video"], self.last["text"]
        ecfg = self.tc["emodel"]
        vc, ic = v["cum"], vi["cum"]
        mean_mos = self.voice.mos_sum / self.voice.mos_n if self.voice.mos_n else None
        codec = qos.val(ecfg, "codec_delay_ms", 20)
        vm = {"network_delay_ms": vc["delay_mean"], "jitter_ms": vc["jitter_mean_ms"], "loss_pct": vc["loss_pct"],
              "mouth_to_ear_delay_ms": (vc["delay_mean"] + (v["buffer_ms"] or 0) + codec) if vc["delay_mean"] is not None else None,
              "mos": mean_mos}
        im = {"network_delay_ms": ic["delay_mean"], "jitter_ms": ic["jitter_mean_ms"], "loss_pct": ic["loss_pct"],
              "playout_delay_ms": (ic["delay_mean"] + (vi["buffer_ms"] or 0)) if ic["delay_mean"] is not None else None,
              "freeze_ms": vi["longest_freeze_ms"]}
        tm = {"delivery_ms": tx["max_delivery_ms"], "lost_messages": tx["cn_failed"] if tx["delivered"] else None}
        ev = {"voice": qos.evaluate("voice", vm, self.tc), "video": qos.evaluate("video", im, self.tc),
              "text": qos.evaluate("text", tm, self.tc)}
        ints = self.voice.interruptions
        outs = [{"duration_ms": o["duration_ms"], "recover_ms": o["recover_ms"]} for o in self.outages]
        rec_all = [x for o in self.outages for x in (o["recover_ms"]["voice"], o["recover_ms"]["video"]) if x is not None]
        return {
            "label": label, "t": round(now, 1),
            "run_s": round((now - self.run_start) / 1000.0, 1) if self.run_start else 0,
            "voice": {"sent": vc["sent_est"], "received": vc["received"], "lost": vc["lost"], "late": vc["late"],
                      "loss_pct": _r(vc["loss_pct"], 2), "longest_burst": vc["longest_burst"], "ooo": vc["ooo"],
                      "delay_mean": _r(vc["delay_mean"]), "delay_p95": _r(vc["delay_p95"]), "delay_max": _r(vc["delay_max"]),
                      "jitter_mean": _r(vc["jitter_mean_ms"], 2), "jitter_max": _r(vc["jitter_max_ms"], 2),
                      "worst_mos": _r(self.voice.worst_mos, 2), "worst_mos_clear": _r(self.voice.worst_mos_clear, 2),
                      "mean_mos": _r(mean_mos, 2), "poor_s": round(self.voice.mos_poor_ms / 1000.0, 1),
                      "interruptions": len(ints), "interruption_ms": round(sum(i["ms"] for i in ints), 1),
                      "longest_interruption_ms": round(max((i["ms"] for i in ints), default=0), 1),
                      "verdict": ev["voice"]["level"], "reason": ev["voice"]["reason"]},
            "video": {"frames_total": vi["frames_total"], "frames_lost": vi["frames_lost"],
                      "frames_lost_pct": _r(100.0 * vi["frames_lost"] / vi["frames_total"], 1) if vi["frames_total"] else None,
                      "freezes": vi["freezes"], "freeze_s": round(vi["freeze_ms"] / 1000.0, 1),
                      "longest_freeze_s": round(vi["longest_freeze_ms"] / 1000.0, 1),
                      "loss_pct": _r(ic["loss_pct"], 2), "late": ic["late"],
                      "delay_mean": _r(ic["delay_mean"]), "jitter_mean": _r(ic["jitter_mean_ms"], 2),
                      "interruptions": len(self.video.interruptions),
                      "verdict": ev["video"]["level"], "reason": ev["video"]["reason"]},
            "text": {"delivered": tx["delivered"], "sent": tx["cn_sent"], "lost": tx["cn_failed"],
                     "max_delivery_s": round((tx["max_delivery_ms"] or 0) / 1000.0, 1),
                     "mean_delivery_s": round((tx["mean_delivery_ms"] or 0) / 1000.0, 2),
                     "retx_delivered": tx["retx_delivered"],
                     "verdict": ev["text"]["level"], "reason": ev["text"]["reason"]},
            "outages": outs, "recover_s": round(max(rec_all) / 1000.0, 1) if rec_all else None,
            "handoffs": self.handoffs,
            "checks": {k: v2["checks"] for k, v2 in ev.items()},
        }


def _r(v, nd=1):
    return None if v is None else round(v, nd)


def _ms(v):
    return "n/a" if v is None else "%.1f s" % (v / 1000.0)
