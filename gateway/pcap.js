// Writes captured virtual IPv4 datagrams as a classic libpcap file.
// LINKTYPE_RAW (101): every record starts directly with the IPv4 header, which is exactly
// what the agents put on the virtual wire, so Wireshark decodes the file without any plugin.
'use strict';

const LINKTYPE_RAW = 101;
const SNAPLEN = 65535;

/** Build the 24-byte global header (little endian, microsecond timestamps). */
function globalHeader() {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(0xa1b2c3d4, 0); // magic
  b.writeUInt16LE(2, 4);           // version major
  b.writeUInt16LE(4, 6);           // version minor
  b.writeInt32LE(0, 8);            // thiszone
  b.writeUInt32LE(0, 12);          // sigfigs
  b.writeUInt32LE(SNAPLEN, 16);
  b.writeUInt32LE(LINKTYPE_RAW, 20);
  return b;
}

/** records: [{ ts: milliseconds since epoch, data: Buffer }] */
function build(records) {
  const parts = [globalHeader()];
  for (const r of records) {
    const h = Buffer.alloc(16);
    const sec = Math.floor(r.ts / 1000);
    const usec = Math.round((r.ts - sec * 1000) * 1000);
    h.writeUInt32LE(sec, 0);
    h.writeUInt32LE(Math.min(usec, 999999), 4);
    const incl = Math.min(r.data.length, SNAPLEN);
    h.writeUInt32LE(incl, 8);
    h.writeUInt32LE(r.data.length, 12);
    parts.push(h, r.data.subarray(0, incl));
  }
  return Buffer.concat(parts);
}

module.exports = { build, globalHeader, LINKTYPE_RAW };
