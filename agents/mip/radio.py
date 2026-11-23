"""The mobile node's radio logic: what it does with the signal readings the core router sends.

Every report_interval the router sends the mobile node the signal strength of each network
(frame kind SIGNAL, a measurement, not a radio frame). From those the node decides:

  which network to be on
      baseline        the strongest network right now, no margin, no waiting, no averaging.
                      Deliberately naive. It ping-pongs where two cells cross.
      signal_handoff  (feature) average the readings, then switch only when the current signal is
                      below switch_below_dbm AND another network is stronger by margin_db, and has
                      been for dwell_ms, and the last switch was at least min_stay_ms ago. A
                      current network that is already unusable skips the waiting.
  whether to stay on two networks while they overlap
      auto_simultaneous (feature) keeps the old link as an extra association and registers the
                      new care-of address with the S flag (RFC 3344 section 3.6.1.2). The home
                      agent then tunnels a copy to both and the node drops the duplicates.
  what to do when the signal comes back after a dead zone
      fast_rereg      (feature) send an Agent Solicitation at once and re-register, instead of
                      waiting for the next advertisement.

It also tells the QoS manager when an outage starts and ends, which is what the time to recover
is measured from.
"""
import json

from . import link


class Radio:
    def __init__(self, mn, topo):
        self.mn = mn
        self.cov = topo.extra("coverage.json")
        self.res = topo.extra("resilience.json")
        self.usable = self.cov["usable_dbm"]
        self.sh = self.res["signal_handoff"]
        self.sf = self.res["auto_simultaneous"]
        self.reset()

    def reset(self):
        self.sig = {}
        self.filt = {}
        self.pos = None
        self.dead = False
        self.cand = None
        self.cand_since = 0.0
        self.last_switch = -1e9
        self.extra = None
        self.extra_since = 0.0
        self.switches = 0
        self.overlaps = 0

    # ---- signal reports -----------------------------------------------------------------
    def on_signal(self, payload):
        mn = self.mn
        if not mn.features.get("coverage"):
            return
        try:
            d = json.loads(payload.decode())
        except ValueError:
            return
        now = mn.now()
        self.sig, self.pos = d["sig"], d["pos"]
        a = self.sh["filter_alpha"]
        self.filt = dict(self.sig) if not self.filt else {k: (1 - a) * self.filt.get(k, v) + a * v for k, v in self.sig.items()}
        cur = mn.link
        mn.qos.signal = self.sig.get(cur, -200.0)
        usable = {k: v for k, v in self.sig.items() if v >= self.usable}
        dead = not usable
        if dead and not self.dead:
            self.dead = True
            mn.qos.outage_start(mn.now_ms())
        elif not dead and self.dead:
            self.dead = False
            mn.qos.outage_end(mn.now_ms())
            self.signal_returned()
        if self.extra and (self.sig.get(self.extra, -200.0) < self.usable or now - self.extra_since > self.sf["max_overlap_s"]):
            self.drop_extra("its signal is gone" if self.sig.get(self.extra, -200.0) < self.usable else "overlap time is up")
        if dead:
            return
        if mn.features.get("signal_handoff"):
            self.hysteresis(cur, now, usable)
        else:
            best = max(usable, key=usable.get)
            if best != cur and usable[best] > self.sig.get(cur, -200.0):
                self.switch(best, "strongest network right now (%d dBm against %d dBm)" % (
                    usable[best], self.sig.get(cur, -200.0)))

    def hysteresis(self, cur, now, usable):
        f = self.filt
        fu = {k: v for k, v in f.items() if v >= self.usable} or usable
        cs = f.get(cur, -200.0)
        best = max(fu, key=fu.get)
        cand = best if best != cur and fu[best] >= cs + self.sh["margin_db"] else None
        urgent = self.sig.get(cur, -200.0) < self.usable
        need = cs < self.sh["switch_below_dbm"] or urgent
        if need and cand:
            if self.cand != cand:
                self.cand, self.cand_since = cand, now
            if (now - self.cand_since >= self.sh["dwell_ms"] / 1000.0 or urgent) and \
                    (now - self.last_switch >= self.sh["min_stay_ms"] / 1000.0 or urgent):
                self.switch(cand, "current %d dBm is weak and %d dBm is stronger by %d dB or more" % (
                    cs, fu[cand], self.sh["margin_db"]))
        else:
            self.cand = None

    # ---- acting on it ---------------------------------------------------------------------
    def switch(self, new, why):
        mn = self.mn
        old = mn.link
        now = mn.now()
        self.last_switch = now
        self.cand = None
        self.switches += 1
        # keep the old link only while it can still be heard: the averaged reading is the fairer test
        keep = (mn.features.get("auto_simultaneous") and old != mn.home_link and new != mn.home_link
                and self.filt.get(old, self.sig.get(old, -200.0)) >= self.usable)
        mn.tel.emit("movement", "radio: %s to %s, %s" % (mn.label(old), mn.label(new), why), old=old, new=new,
                    rfc="RFC 3344 section 2.4 (when to hand off is our policy)")
        mn.attach(new)
        if keep:
            mn.send_raw(link.ATTACH_EXTRA, old.encode())
            self.extra, self.extra_since = old, now
            self.overlaps += 1
            mn.tel.emit("movement", "overlap: the node stays on %s while it registers on %s with the S flag" % (
                mn.label(old), mn.label(new)), rfc="RFC 3344 section 3.6.1.2",
                learn="With the S bit set the home agent keeps the old binding and tunnels a copy of every datagram "
                      "to both care-of addresses. The mobile node receives two copies and discards the second.")

    def drop_extra(self, why):
        if not self.extra:
            return
        self.mn.send_raw(link.DETACH_EXTRA, self.extra.encode())
        self.mn.tel.emit("movement", "overlap over: the node leaves %s (%s)" % (self.mn.label(self.extra), why))
        self.extra = None

    def signal_returned(self):
        mn = self.mn
        if not mn.features.get("fast_rereg") or mn.state == "AT_HOME":
            return
        mn.tel.emit("movement", "signal is back: solicitation and re-registration at once", rfc="RFC 3344 section 2.4.1",
                    learn="Instead of waiting for the next periodic advertisement, the mobile node asks for one and "
                          "re-registers the moment it can hear a network again.")
        mn.solicit()
        a = mn.agents.get(mn.binding["agent"]) if mn.binding else None
        if a and mn.state in ("REGISTERED_AWAY", "RENEWING"):
            mn.register(a, reason="signal returned", renewal=True)

    def snapshot(self):
        return {"sig": self.sig, "pos": self.pos, "dead": self.dead, "extra": self.extra, "switches": self.switches,
                "overlaps": self.overlaps}
