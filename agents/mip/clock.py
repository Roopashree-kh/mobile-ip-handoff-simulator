"""High-resolution clocks that behave the same on Windows and Linux.

On Windows time.monotonic() and queue timeouts tick every 15.6 ms, which is coarser than the
link delays we emulate. perf_counter() is precise, so:
  mono()  - perf_counter, for timers inside one process
  now()   - wall-clock seconds with perf_counter resolution, anchored to time.time() at the
            moment the system clock ticks over, so different processes agree to within about
            one millisecond. Used for latency measured across processes.
"""
import time

_pc0 = None
_t0 = None


def _calibrate():
    global _pc0, _t0
    start = time.time()
    deadline = time.perf_counter() + 0.05
    t = start
    while t == start and time.perf_counter() < deadline:
        t = time.time()
    _pc0, _t0 = time.perf_counter(), t


def mono():
    return time.perf_counter()


def now():
    if _pc0 is None:
        _calibrate()
    return _t0 + (time.perf_counter() - _pc0)


def now_ms():
    return now() * 1000.0
