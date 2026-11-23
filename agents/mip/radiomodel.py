"""Signal strength along the Metro ride (config/coverage.json).

signal(network, x) = max over the network's cells of  ref_dbm_1m - 10 * n * log10(max(d, d_min))
                     + fade(x) - dead_zone_loss(x)

The fade is a sum of two sine waves of position, so it is smooth and repeatable: the same
position always gives the same signal. That makes two runs of the ride comparable. It stands in
for shadowing, it is not a measured radio channel. This model is ours, not from a standard.
"""
import math


class RadioModel:
    def __init__(self, cfg):
        self.cfg = cfg
        self.usable = cfg["usable_dbm"]
        self.dmin = cfg.get("min_distance_m", 20)
        f = cfg.get("fading", {})
        self.amp = f.get("amp_db", 0)
        self.wl = f.get("wavelengths_m", [23, 9])
        self.phases = f.get("phases", {})
        self.zones = cfg.get("dead_zones", [])

    def fade(self, net, x):
        p = self.phases.get(net, 0.0)
        return self.amp * (0.6 * math.sin(2 * math.pi * x / self.wl[0] + p) + 0.4 * math.sin(2 * math.pi * x / self.wl[1] + 2 * p))

    def dead_loss(self, x):
        for z in self.zones:
            if z["from_m"] <= x <= z["to_m"]:
                ramp = max(1.0, z.get("ramp_m", 1))
                return z["extra_loss_db"] * min(1.0, (x - z["from_m"]) / ramp, (z["to_m"] - x) / ramp)
        return 0.0

    def signals(self, x):
        out = {}
        for net, n in self.cfg["networks"].items():
            best = max(n["ref_dbm_1m"] - 10 * n["exponent"] * math.log10(max(abs(x - c), self.dmin)) for c in n["cells"])
            out[net] = round(best + self.fade(net, x) - self.dead_loss(x), 1)
        return out

    def in_dead_zone(self, x):
        return any(z["from_m"] <= x <= z["to_m"] for z in self.zones)

    def place(self, x):
        for z in self.zones:
            if z["from_m"] <= x <= z["to_m"]:
                return z["name"]
        name = self.cfg["route"]["waypoints"][0]["name"]
        for w in self.cfg["route"]["waypoints"]:
            if w["link"] is not None and w["at_m"] <= x + 150:
                name = w["name"]
        return name
