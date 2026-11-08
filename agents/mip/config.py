"""Loads config/topology.json and offers small lookup helpers.

The path can be overridden with the MIP_CONFIG environment variable, which is how the
integration test runs a second copy of the simulator on different ports.
"""
import ipaddress
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.normpath(os.path.join(_HERE, "..", "..", "config", "topology.json"))


class Topology:
    """Read-only view of the topology file with convenience accessors."""

    def __init__(self, data, path=None):
        self.data = data
        self.path = path
        self.host = data.get("localhost", "127.0.0.1")
        self.nodes = data["nodes"]
        self.links = data["links"]
        self.mip = data["mobile_ip"]
        self.security = data["security"]
        self.defaults = data["defaults"]
        self.backbone = data["backbone"]
        self.gateway = data["gateway"]
        self._by_id = {v["id"]: k for k, v in self.nodes.items()}

    # ---- nodes -------------------------------------------------------------
    def node(self, name):
        return self.nodes[name]

    def node_name(self, node_id):
        return self._by_id.get(node_id, "?%d" % node_id)

    def node_id(self, name):
        return self.nodes[name]["id"]

    def foreign_agents(self):
        return [n for n, v in self.nodes.items() if v["role"] == "foreign_agent"]

    def agent_names(self):
        """Every process that has a control port, i.e. everything except the gateway."""
        return list(self.nodes.keys())

    def data_addr(self, name):
        return (self.host, self.nodes[name]["data_port"])

    def control_addr(self, name):
        return (self.host, self.nodes[name]["control_port"])

    def telemetry_addr(self):
        return (self.host, self.gateway["telemetry_port"])

    # ---- links -------------------------------------------------------------
    def link_network(self, link):
        return ipaddress.ip_network(self.links[link]["prefix"])

    def link_of_ip(self, ip):
        """Return the link whose prefix contains ip, or None."""
        addr = ipaddress.ip_address(ip)
        for name, l in self.links.items():
            if addr in ipaddress.ip_network(l["prefix"]):
                return name
        return None

    def agent_for_link(self, link):
        """The mobility agent (HA or FA) that serves a link, or None."""
        for n, v in self.nodes.items():
            if v.get("link") == link and v["role"] in ("home_agent", "foreign_agent"):
                return n
        return None


def mac_for(node_id):
    """Locally administered MAC address derived from the node id (02:00:5e:00:00:id)."""
    return bytes([0x02, 0x00, 0x5E, 0x00, 0x00, node_id & 0xFF])


def load(path=None):
    path = path or os.environ.get("MIP_CONFIG") or DEFAULT_PATH
    with open(path, "r", encoding="utf-8") as f:
        return Topology(json.load(f), path)


def in_prefix(ip, prefix):
    return ipaddress.ip_address(ip) in ipaddress.ip_network(prefix)


def prefix_len(prefix):
    return ipaddress.ip_network(prefix).prefixlen


def network_of(ip, plen):
    return str(ipaddress.ip_network("%s/%d" % (ip, plen), strict=False))
