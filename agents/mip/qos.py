"""Quality of service measurement for the three application flows (voice, video, chat).

The correspondent stamps every packet with a 28-byte flow header (flow id, type, flags, route
tag, sequence number, send time, packet interval, frame id, fragment index and count). The
mobile node feeds each arrival to one monitor per flow and gets, per sliding window and
cumulatively:

  one-way delay (mean, p95, max)          arrival time minus the stamped send time
  jitter                                  RFC 3550 section 6.4.1 and appendix A.8,
                                          J = J + (|D| - J) / 16 on consecutive arrivals
  packet loss                             gaps in the sequence numbers, plus packets that
                                          arrive after their playout deadline (late loss)
  longest loss burst, out-of-order, dups
  interruption                            gap between the last packet before a link change
                                          and the first one after it

Voice also gets the simplified E-model of ITU-T G.107 (R and MOS). Video gets frame level
accounting: freeze count and freeze time, because a lost fragment ruins its frame and every
delta frame after it until the next key frame. Chat gets delivery time per message.

All targets come from config/qos_targets.json with a source for each number. Nothing here
is a unit under test. It is exercised by running the simulator.
"""
import math
import struct
from collections import OrderedDict

MAGIC = b"MIPQ"
HDR = struct.Struct("!4sBBBBIdHIBB")   # 28 bytes
HDR_LEN = HDR.size

T_VOICE, T_VIDEO, T_TEXT, T_ACK = 1, 2, 3, 4
F_KEY, F_RETX = 1, 2
OK, LATE, LOST = 1, 2, 3
MAX_GAP = 20000


def pack(flow_id, ftype, flags, tag, seq, ts_ms, interval_ms, frame_id=0, frag_idx=0, frag_cnt=1):
    return HDR.pack(MAGIC, flow_id, ftype, flags, tag, seq & 0xFFFFFFFF, ts_ms,
                    int(round(interval_ms * 10)) & 0xFFFF, frame_id & 0xFFFFFFFF, frag_idx, frag_cnt)


def unpack(data):
    """Return a dict for a flow packet, or None when the bytes are not one."""
    if len(data) < HDR_LEN or data[:4] != MAGIC:
        return None
    _, fid, ft, fl, tag, seq, ts, iv, frame, fi, fc = HDR.unpack(data[:HDR_LEN])
    return {"flow_id": fid, "ftype": ft, "flags": fl, "tag": tag, "seq": seq, "ts": ts,
            "interval_ms": iv / 10.0, "frame_id": frame, "frag_idx": fi, "frag_cnt": fc, "body": data[HDR_LEN:]}


def percentile(values, p):
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p / 100.0
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def val(d, key, default=None):
    """Read config/qos_targets.json style entries, which are {"value": x, ...}."""
    e = d.get(key)
    return e["value"] if isinstance(e, dict) else (default if e is None else e)


# ---------------------------------------------------------------------------------------
# E-model, ITU-T G.107 (simplified, see docs/PROTOCOL_NOTES.md)
# ---------------------------------------------------------------------------------------
def emodel(ta_ms, ppl_pct, burst_r, ecfg):
    """Return (R, MOS, Id, Ie_eff) for a G.711 call.

    R = Ro - Id - Ie_eff with Ro = 93.2 (G.107 clause 7.7 default R, which already folds in
    the default Is and A). Id is the delay impairment Idd of G.107 equation 7-27. The echo
    terms Idte and Idle are taken as zero, which assumes good echo control.
    Ie_eff = Ie + (95 - Ie) * Ppl / (Ppl / BurstR + Bpl), G.107 equation 7-29.
    """
    ro, ie, bpl = val(ecfg, "ro"), val(ecfg, "ie"), val(ecfg, "bpl")
    mt, st = val(ecfg, "idd_mt_ms"), val(ecfg, "idd_st")
    idd = 0.0
    if ta_ms > mt:
        x = math.log(ta_ms / mt, 2)
        e = 6.0 * st
        idd = 25.0 * ((1 + x ** e) ** (1 / e) - 3 * (1 + (x / 3.0) ** e) ** (1 / e) + 2)
    burst_r = max(burst_r, val(ecfg, "burst_r_min", 1))
    ie_eff = ie + (95.0 - ie) * ppl_pct / (ppl_pct / burst_r + bpl) if ppl_pct > 0 else ie
    r = max(0.0, min(100.0, ro - idd - ie_eff))
    return r, mos_from_r(r), idd, ie_eff


def mos_from_r(r):
    """ITU-T G.107 Annex B equation B-4."""
    if r < 0:
        return 1.0
    if r > 100:
        return 4.5
    # the polynomial dips just below 1 for R under about 7, so the result is clamped to 1 to 4.5
    return max(1.0, min(4.5, 1 + 0.035 * r + r * (r - 60) * (100 - r) * 7e-6))


def r_band(r, ecfg_bands):
    for b in ecfg_bands:
        if r >= b["r_min"]:
            return b["label"]
    return "Not recommended"


# ---------------------------------------------------------------------------------------
# verdicts
# ---------------------------------------------------------------------------------------
SHORT = {"mouth_to_ear_delay_ms": "delay", "playout_delay_ms": "delay", "network_delay_ms": "network delay",
         "jitter_ms": "jitter", "loss_pct": "loss", "mos": "voice quality score", "freeze_ms": "frozen picture",
         "delivery_ms": "message delivery time", "lost_messages": "lost messages"}


def _n(v, unit):
    if v is None:
        return "-"
    if unit == "%":
        s = ("%.2f" % v).rstrip("0").rstrip(".") if v < 10 else "%.1f" % v
        return s + "%"
    if unit == "ms":
        return ("%d ms" % round(v)) if abs(v) >= 10 else ("%.1f ms" % v)
    return ("%.2f" % v).rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def evaluate(kind, metrics, tcfg, stall_ms=0.0):
    """Compare one flow's metrics with its targets. Returns {level, reason, checks}.

    level is good, fair, poor or idle. A check that misses pass_at but is inside hard_at (or has
    no hard_at) makes the flow fair. A check past hard_at, or a stall longer than stall_poor_ms,
    makes it poor.
    """
    fcfg = tcfg["flows"][kind]
    checks, hard, soft = [], [], []
    for key, c in fcfg["checks"].items():
        v = metrics.get(key)
        unit = c.get("unit", "")
        lim = c["hard_at"]
        if c["direction"] == "min":
            target = ">= %s%s" % (c["pass_at"], (" (limit %s)" % lim) if lim is not None else "")
        else:
            target = "<= %s %s" % (c["pass_at"], unit)
            if lim is not None and lim != c["pass_at"]:
                target += " (limit %s %s)" % (lim, unit)
        target = target.replace(" %", "%").strip()
        st = "na"
        if v is not None:
            if c["direction"] == "min":
                st = "pass" if v >= c["pass_at"] else ("hard" if lim is not None and v < lim else "soft")
            else:
                st = "pass" if v <= c["pass_at"] else ("hard" if lim is not None and v > lim else "soft")
        row = {"key": key, "label": c["label"], "unit": unit, "measured": None if v is None else round(v, 3),
               "target": target, "status": st, "source": c["source"], "verified": c["verified"]}
        checks.append(row)
        if st in ("hard", "soft"):
            bound = lim if (st == "hard" and lim is not None) else c["pass_at"]
            word = "below" if c["direction"] == "min" else "above"
            text = "%s %s is %s the %s limit" % (SHORT.get(key, c["label"].lower()), _n(v, unit), word, _n(bound, unit))
            if key == "mos":
                text = "voice quality score %.1f is below the %.1f limit" % (v, bound)
            if key == "lost_messages":
                text = "%d chat message%s lost" % (v, "" if v == 1 else "s")
            (hard if st == "hard" else soft).append(text)
    reason = None
    level = "good"
    stall_poor = tcfg.get("stall_poor_ms", 1000)
    if stall_ms >= stall_poor and kind != "text":
        level, reason = "poor", "no packets for %.1f s" % (stall_ms / 1000.0)
    elif hard:
        level, reason = "poor", hard[0]
    elif soft:
        level, reason = "fair", soft[0]
    elif all(r["status"] == "na" for r in checks):
        level, reason = "idle", "waiting for data"
    else:
        reason = "all targets met"
    return {"level": level, "reason": reason, "checks": checks}


# ---------------------------------------------------------------------------------------
# playout buffer
# ---------------------------------------------------------------------------------------
class Playout:
    """Receiver playout model. A packet whose network delay exceeds the current playout offset
    arrives after the moment a player would have needed it, so it counts as a late loss.

    adaptive: offset = d + clamp(k * v, min_buffer, max_buffer) where d and v are exponential
              averages of the delay and its deviation. This is algorithm 1 of Ramjee, Kurose,
              Towsley and Schulzrinne (INFOCOM 1994), applied to every packet. The buffer is
              therefore sized from the measured jitter.
    fixed:    offset = fixed_ms, the total delay budget counted from the send time.
    """

    def __init__(self, cfg):
        self.cfg = cfg
        self.d = None
        self.v = 0.0

    def buffer_ms(self):
        c = self.cfg
        if c.get("mode") == "fixed":
            return max(0.0, c["fixed_ms"] - (self.d or 0.0))
        return min(c["max_buffer_ms"], max(c["min_buffer_ms"], c["k"] * self.v))

    def offset_ms(self):
        if self.d is None:
            return None
        if self.cfg.get("mode") == "fixed":
            return float(self.cfg["fixed_ms"])
        return self.d + self.buffer_ms()

    def feed(self, delay):
        """Judge one arrival against the offset in force, then learn from it. True when late."""
        off = self.offset_ms()
        late = off is not None and delay > off
        x = min(max(delay, 0.0), self.cfg.get("clamp_ms", 1000))
        if self.d is None:
            self.d, self.v = x, 0.0
        else:
            a = self.cfg["alpha"]
            self.d = a * self.d + (1 - a) * x
            self.v = a * self.v + (1 - a) * abs(x - self.d)
        return late


# ---------------------------------------------------------------------------------------
# sequence based flows: voice and video
# ---------------------------------------------------------------------------------------
class SeqFlow:
    def __init__(self, kind, fcfg, tcfg, window_s):
        self.kind, self.fcfg, self.tcfg = kind, fcfg, tcfg
        self.window_ms = window_s * 1000.0
        self.ecfg = tcfg.get("emodel", {})
        self.int_min = fcfg.get("interruption_min_ms", 100)
        self.reset()

    def reset(self):
        self.pl = Playout(self.fcfg["playout"])
        self.base = None
        self.expected = 0
        self.hist = bytearray()
        self.recs = OrderedDict()          # seq -> [t_ms, status, delay_ms], the sliding window
        self.rx = self.late_n = self.lost_n = self.ooo = self.dup = 0
        self.cum_delays = []
        self.jitter = self.jitter_max = 0.0
        self.jitter_sum = 0.0
        self.jitter_n = 0
        self.prev_delay = None
        self.last_arr = None
        self.last_seq = None
        self.last_link = None
        self.pkt_interval = float(self.fcfg.get("packet_interval_ms", 20))
        self.gap_unit = self.pkt_interval
        self.interruptions = []
        self.worst_mos = None
        self.worst_mos_clear = None        # worst MOS while not in or just after a blackout
        self.mos_poor_ms = 0.0
        self.mos_sum = 0.0
        self.mos_n = 0
        self.last_report = None

    # ---- arrivals ---------------------------------------------------------------------
    def on_packet(self, pk, arr, link):
        seq, ts = pk["seq"], pk["ts"]
        delay = arr - ts
        if pk["interval_ms"]:
            self._set_interval(pk["interval_ms"])
        if self.base is None:
            self.base = seq
            self.expected = seq
        elif seq == 0 and self.expected > 10:
            self._restart()
            self.base = seq
            self.expected = seq
        idx = seq - self.base
        inorder = False
        if seq >= self.expected:
            if seq - self.expected > MAX_GAP:
                self._restart()
                self.base = self.expected = seq
                idx = 0
            for s in range(self.expected, seq):
                est = arr
                if self.last_arr is not None and self.last_seq is not None:
                    est = min(arr, self.last_arr + (s - self.last_seq) * self.pkt_interval)
                self.hist.append(LOST)
                self.recs[s] = [est, LOST, None]
                self.lost_n += 1
            self.hist.append(OK)
            self.expected = seq + 1
            inorder = True
        else:
            if idx < 0 or idx >= len(self.hist) or self.hist[idx] != LOST:
                self.dup += 1
                return None
            self.ooo += 1
            self.lost_n -= 1
        offset = self.pl.offset_ms()
        late = self.pl.feed(delay)
        st = LATE if late else OK
        self.hist[idx] = st
        if seq in self.recs:
            r = self.recs[seq]
            r[1], r[2] = st, delay
        else:
            self.recs[seq] = [arr, st, delay]
        self.rx += 1
        if late:
            self.late_n += 1
        if len(self.cum_delays) < 40000:
            self.cum_delays.append(delay)
        interruption = None
        if inorder:
            if self.prev_delay is not None:
                d = abs(delay - self.prev_delay)
                self.jitter += (d - self.jitter) / 16.0     # RFC 3550 section 6.4.1
                self.jitter_max = max(self.jitter_max, self.jitter)
                self.jitter_sum += self.jitter
                self.jitter_n += 1
            self.prev_delay = delay
            if self.last_arr is not None and arr - self.last_arr >= self.int_min:
                interruption = {"flow": self.kind, "start_ms": self.last_arr, "end_ms": arr,
                                "ms": round(arr - self.last_arr, 1), "from_link": self.last_link, "to_link": link,
                                "cause": "handoff" if (self.last_link and link != self.last_link) else "gap"}
                if len(self.interruptions) < 300:
                    self.interruptions.append(interruption)
            self.last_arr, self.last_seq, self.last_link = arr, seq, link
        self._prune(arr)
        return {"late": late, "delay": delay, "offset": offset, "inorder": inorder, "interruption": interruption}

    def _set_interval(self, iv):
        self.pkt_interval = iv
        self.gap_unit = iv

    def _restart(self):
        self.hist = bytearray()
        self.recs.clear()
        self.prev_delay = None
        self.last_arr = self.last_seq = None

    def _prune(self, now):
        lo = now - self.window_ms
        while self.recs:
            k = next(iter(self.recs))
            if self.recs[k][0] < lo:
                del self.recs[k]
            else:
                break

    # ---- stall estimate ----------------------------------------------------------------
    def silent_ms(self, now):
        return 0.0 if self.last_arr is None else max(0.0, now - self.last_arr)

    def pending(self, now, cap=None):
        """Packets that should have arrived by now but cannot be counted as a gap yet because
        no later packet has arrived. This is what makes a blackout visible while it lasts."""
        if self.last_arr is None:
            return 0
        grace = max(3 * self.gap_unit, 2 * (self.pl.d or 0.0))
        silent = now - self.last_arr
        if silent <= grace:
            return 0
        n = int((silent - grace) / max(1.0, self.pkt_interval)) + 1
        return min(n, cap) if cap else n

    # ---- reports -----------------------------------------------------------------------
    def window_stats(self, now):
        self._prune(now)
        ok = late = lost = 0
        delays, bursts, run = [], [], 0
        for _, st, d in self.recs.values():
            if st == LOST:
                lost += 1
                run += 1
            elif st == LATE:
                late += 1
                run += 1
                delays.append(d)
            else:
                ok += 1
                delays.append(d)
                if run:
                    bursts.append(run)
                    run = 0
        pend = self.pending(now, cap=int(self.window_ms / max(1.0, self.pkt_interval)))
        lost += pend
        run += pend
        if run:
            bursts.append(run)
        total = ok + late + lost
        bad = lost + late
        out = {"total": total, "received": ok + late, "lost": lost, "late": late, "pending": pend,
               "loss_pct": (100.0 * bad / total) if total else None,
               "net_loss_pct": (100.0 * lost / total) if total else None,
               "late_pct": (100.0 * late / total) if total else None,
               "delay_mean": (sum(delays) / len(delays)) if delays else None,
               "delay_p95": percentile(delays, 95), "delay_max": max(delays) if delays else None,
               "delay_min": min(delays) if delays else None, "longest_burst": max(bursts) if bursts else 0}
        p = bad / total if total else 0.0
        l_obs = bad / len(bursts) if bursts else 0.0
        out["burst_r"] = max(val(self.ecfg, "burst_r_min", 1), l_obs * (1 - p)) if bursts else 1.0
        return out

    def cumulative(self, now):
        pend = self.pending(now)
        sent_est = (self.expected - self.base + pend) if self.base is not None else 0
        bad = self.lost_n + self.late_n + pend
        tbl = bytes((0 if i == OK else 1) for i in range(256))
        s = bytes(self.hist).translate(tbl)
        longest = max((len(x) for x in s.split(b"\x00")), default=0)
        longest = max(longest, pend + (len(s) - len(s.rstrip(b"\x01")) if pend else 0))
        cd = self.cum_delays
        return {"sent_est": sent_est, "received": self.rx, "lost": self.lost_n + pend, "late": self.late_n,
                "loss_pct": (100.0 * bad / sent_est) if sent_est else None,
                "ooo": self.ooo, "dup": self.dup, "longest_burst": longest,
                "delay_mean": (sum(cd) / len(cd)) if cd else None, "delay_p95": percentile(cd, 95),
                "delay_max": max(cd) if cd else None,
                "jitter_ms": self.jitter, "jitter_max_ms": self.jitter_max,
                "jitter_mean_ms": (self.jitter_sum / self.jitter_n) if self.jitter_n else 0.0}

    def metrics_for(self, win, now):
        """Numbers handed to evaluate()."""
        stall = self.silent_ms(now)
        m = {"network_delay_ms": win["delay_mean"], "jitter_ms": self.jitter if self.rx > 2 else None,
             "loss_pct": win["loss_pct"]}
        return m, stall

    def report(self, now, interval_ms, clear):
        win = self.window_stats(now)
        cum = self.cumulative(now)
        m, stall = self.metrics_for(win, now)
        rep = {"window": win, "cum": cum, "stall_ms": round(stall, 1), "playout_ms": self.pl.offset_ms(),
               "buffer_ms": self.pl.buffer_ms() if self.pl.d is not None else None,
               "last_link": self.last_link, "active": self.last_arr is not None}
        self._extend(rep, win, m, now, interval_ms, clear)
        ev = evaluate(self.kind, m, self.tcfg, stall)
        rep["verdict"] = ev
        self.last_report = rep
        return rep

    def _extend(self, rep, win, m, now, interval_ms, clear):
        """Voice: E-model."""
        off = self.pl.offset_ms()
        if off is None or win["total"] == 0:
            m["mouth_to_ear_delay_ms"] = None
            m["mos"] = None
            rep["r"] = rep["mos"] = None
            return
        ta = off + val(self.ecfg, "codec_delay_ms", 20)
        ppl = win["loss_pct"] or 0.0
        r, mos, idd, ie_eff = emodel(ta, ppl, win["burst_r"], self.ecfg)
        m["mouth_to_ear_delay_ms"] = ta
        m["mos"] = mos
        rep.update({"r": round(r, 1), "mos": round(mos, 2), "id": round(idd, 1), "ie_eff": round(ie_eff, 1),
                    "ta_ms": round(ta, 1), "r_label": r_band(r, self.tcfg.get("mos_bands", []))})
        # a window that has barely filled (the first second of a run) gives a meaningless loss ratio,
        # so it does not count towards the run statistics
        if win["total"] < self.tcfg.get("settle_fraction", 0.6) * self.window_ms / max(1.0, self.pkt_interval):
            return
        self.mos_n += 1
        self.mos_sum += mos
        if self.worst_mos is None or mos < self.worst_mos:
            self.worst_mos = mos
        if clear and (self.worst_mos_clear is None or mos < self.worst_mos_clear):
            self.worst_mos_clear = mos
        if mos < 3.1:
            self.mos_poor_ms += interval_ms


class VideoFlow(SeqFlow):
    """Packet level accounting plus frame level accounting.

    A frame is shown only when every fragment arrived before its playout deadline. A delta
    frame also needs the frame before it: after any failure the decoder is stuck until the next
    key frame. The picture is frozen whenever the gap between two shown frames is longer than
    freeze_frames frame intervals (and at least freeze_min_ms).
    """

    def reset(self):
        super().reset()
        self.frames = {}
        self.next_fid = None
        self.max_fid = -1
        self.frame_int = 1000.0 / 25
        self.decoder_ok = False
        self.displayed = 0
        self.failed = 0
        self.last_disp = None
        self.freezes = 0
        self.freeze_ms = 0.0
        self.freeze_log = []
        self.longest_freeze = 0.0
        self.ppf = 3.0

    def _set_interval(self, iv):
        self.frame_int = iv
        self.gap_unit = iv
        self.pkt_interval = iv / max(1.0, self.ppf)

    def _restart(self):
        """The sender started again at sequence 0: forget the frame state as well, or every new frame
        looks older than the last frame of the previous stream and is ignored."""
        super()._restart()
        self.frames.clear()
        self.next_fid = None
        self.decoder_ok = False
        self.last_disp = None

    def on_packet(self, pk, arr, link):
        info = super().on_packet(pk, arr, link)
        if info is None:
            return None
        fid = pk["frame_id"]
        if self.next_fid is None:
            self.next_fid = fid
        f = self.frames.get(fid)
        if f is None:
            if fid < self.next_fid:
                return info
            off = info["offset"] if info["offset"] is not None else 300.0
            f = self.frames[fid] = {"ts": pk["ts"], "cnt": pk["frag_cnt"], "got": set(),
                                    "key": bool(pk["flags"] & F_KEY), "late": False, "deadline": pk["ts"] + off}
            self.ppf = 0.95 * self.ppf + 0.05 * pk["frag_cnt"]
            self.pkt_interval = self.frame_int / max(1.0, self.ppf)
        f["got"].add(pk["frag_idx"])
        if info["late"]:
            f["late"] = True
        self.max_fid = max(self.max_fid, fid)
        return info

    def tick(self, now):
        for fid in sorted(self.frames):
            f = self.frames[fid]
            if now < f["deadline"]:
                break
            missing = fid - self.next_fid
            if missing > 0:
                self.failed += missing
                self.decoder_ok = False
            good = len(f["got"]) >= f["cnt"] and not f["late"]
            if good and f["key"]:
                self.decoder_ok = True
            if good and self.decoder_ok:
                self._display(f["deadline"])
            else:
                self.failed += 1
                self.decoder_ok = False
            self.next_fid = fid + 1
            del self.frames[fid]

    def _thr(self):
        return max(self.fcfg["freeze_min_ms"], self.fcfg["freeze_frames"] * self.frame_int)

    def _display(self, t):
        if self.last_disp is not None:
            gap = t - self.last_disp
            if gap > self._thr():
                ms = gap - self.frame_int
                self.freezes += 1
                self.freeze_ms += ms
                self.longest_freeze = max(self.longest_freeze, ms)
                self.freeze_log.append((t, ms))
        self.last_disp = t
        self.displayed += 1

    def metrics_for(self, win, now):
        m, stall = super().metrics_for(win, now)
        off = self.pl.offset_ms()
        m["playout_delay_ms"] = off
        lo = now - self.window_ms
        fw = sum(ms for t, ms in self.freeze_log if t >= lo)
        ongoing = self._ongoing(now)
        m["freeze_ms"] = min(fw + ongoing, self.window_ms) if self.last_disp is not None else None
        return m, stall

    def _ongoing(self, now):
        if self.last_disp is None:
            return 0.0
        gap = now - self.last_disp
        return max(0.0, gap - self.frame_int) if gap > self._thr() else 0.0

    def _extend(self, rep, win, m, now, interval_ms, clear):
        ongoing = self._ongoing(now)
        silent = self.silent_ms(now)
        pend_frames = 0
        if self.last_arr is not None and silent > max(3 * self.frame_int, 2 * (self.pl.d or 0.0)):
            pend_frames = int((silent - 3 * self.frame_int) / self.frame_int) + 1
        fin = self.displayed + self.failed
        rep.update({"frames_displayed": self.displayed, "frames_lost": self.failed + pend_frames,
                    "frames_total": fin + pend_frames, "freezes": self.freezes + (1 if ongoing > 0 else 0),
                    "freeze_ms": round(self.freeze_ms + ongoing, 1), "frozen_now": ongoing > 0,
                    "longest_freeze_ms": round(max(self.longest_freeze, ongoing), 1),
                    "frame_interval_ms": round(self.frame_int, 1), "frames_waiting": len(self.frames),
                    "next_deadline_in_ms": round(min(f["deadline"] for f in self.frames.values()) - now, 1) if self.frames else None})


class TextFlow:
    """Chat: delivery time per message. A message is lost only if the sender gives up, which the
    sender reports inside later messages (cn_failed)."""

    def __init__(self, fcfg, tcfg, window_s):
        self.fcfg, self.tcfg = fcfg, tcfg
        self.window_ms = window_s * 1000.0
        self.reset()

    def reset(self):
        self.msgs = {}
        self.log = []
        self.dups = 0
        self.max_id = -1
        self.gaps = {}
        self.cn_failed = 0
        self.cn_sent = 0
        self.last_arr = None
        self.last_link = None
        self.interruptions = []

    def on_message(self, pk, arr, link):
        mid = pk["seq"]
        if mid == 0 and self.max_id > 5:
            self.msgs.clear()
            self.gaps.clear()
            self.max_id = -1
        self.last_arr, self.last_link = arr, link
        try:
            sent, failed, _ = pk["body"].split(b",", 2)
            self.cn_sent, self.cn_failed = int(sent), int(failed)
        except ValueError:
            pass
        if mid in self.msgs:
            self.dups += 1
            return {"new": False, "id": mid}
        if self.max_id < 0:
            self.max_id = mid - 1       # the first message we see is the start, not a gap of everything before it
        delivery = arr - pk["ts"]
        self.msgs[mid] = {"arr": arr, "delivery_ms": delivery, "retx": bool(pk["flags"] & F_RETX), "link": link}
        for i in range(self.max_id + 1, mid):
            if i not in self.msgs:
                self.gaps[i] = arr
        self.gaps.pop(mid, None)
        self.max_id = max(self.max_id, mid)
        self.log.append((arr, delivery))
        if len(self.log) > 2000:
            del self.log[:500]
        return {"new": True, "id": mid, "delivery_ms": delivery, "retx": bool(pk["flags"] & F_RETX)}

    def tick(self, now):
        pass

    def report(self, now, interval_ms, clear):
        lo = now - self.window_ms
        win = [d for t, d in self.log if t >= lo]
        wait = max((now - t for t in self.gaps.values()), default=0.0)
        allv = [m["delivery_ms"] for m in self.msgs.values()]
        m = {"delivery_ms": max(win + [wait]) if (win or wait) else None, "lost_messages": self.cn_failed}
        if not self.msgs:
            m["lost_messages"] = None
        ev = evaluate("text", m, self.tcfg, 0.0)
        rep = {"delivered": len(self.msgs), "max_id": self.max_id, "waiting": len(self.gaps),
               "waiting_ms": round(wait, 1), "copies": self.dups,
               "last_delivery_ms": round(self.log[-1][1], 1) if self.log else None,
               "max_delivery_ms": round(max(allv), 1) if allv else None,
               "mean_delivery_ms": round(sum(allv) / len(allv), 1) if allv else None,
               "retx_delivered": sum(1 for x in self.msgs.values() if x["retx"]),
               "cn_failed": self.cn_failed, "cn_sent": self.cn_sent, "window_max_ms": round(max(win), 1) if win else None,
               "active": bool(self.msgs), "verdict": ev, "last_link": self.last_link}
        return rep
