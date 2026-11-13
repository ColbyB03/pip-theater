"""H.264 over RTP -> whole frames, and the framing used on the PiP page's video stream.

Pure Python, no dependencies: unit-tested in tests/ without a Steam Deck.
The depacketizer follows the approach of decky-screen-mirror (BSD-3-Clause, see LICENSE).
"""
import struct
import time
from typing import List, Optional, Tuple

START_CODE = b"\x00\x00\x00\x01"
HEADER = struct.Struct(">IBQQ")   # payload length, flags, timestamp (us), arrival (ms since 1970)
HEADER_SIZE = HEADER.size         # 21 bytes
FLAG_KEY = 1

Frame = Tuple[bytes, int, bool]   # (Annex B bytes, RTP timestamp at 90 kHz, is key frame)


class H264Depacketizer:
    """RTP (RFC 3550) carrying H.264 (RFC 6184) -> complete frames in Annex B form.

    feed() returns the frames finished by that packet. Nothing is passed on before the first
    key frame. After that a lost packet drops only the frame it belonged to: a phone sends a
    key frame only when mirroring starts (or the screen rotates), so waiting for the next one
    would freeze the picture for good; the decoder conceals the gap instead.
    """

    def __init__(self) -> None:
        self.nals: List[bytes] = []
        self.ts: Optional[int] = None
        self.fu: Optional[bytearray] = None
        self.last_seq: Optional[int] = None
        self.ssrc: Optional[bytes] = None
        self.broken = False       # the frame being assembled lost a packet
        self.need_key = True      # nothing usable until a key frame arrives
        self.sps: Optional[bytes] = None
        self.pps: Optional[bytes] = None
        self.packets = 0
        self.lost = 0
        self.dropped_frames = 0

    def reset(self) -> None:
        """Forget the stream (a new phone connected, or the receiver restarted)."""
        self.__init__()

    def _finish(self) -> Optional[Frame]:
        nals, ts = self.nals, self.ts
        self.nals, self.fu = [], None
        broken, self.broken = self.broken, False
        if broken:
            self.dropped_frames += 1
            return None
        if not nals or ts is None:
            return None
        types = [n[0] & 0x1F for n in nals]
        key = 5 in types
        if self.need_key and not key:
            return None
        if key:
            self.need_key = False
            # A decoder must always get the parameter sets together with a key frame.
            if 7 not in types and self.sps:
                nals.insert(0, self.sps)
                types.insert(0, 7)
            if 8 not in types and self.pps:
                at = types.index(7) + 1 if 7 in types else 0
                nals.insert(at, self.pps)
        return b"".join(START_CODE + n for n in nals), ts, key

    def _add(self, nal: bytes) -> None:
        if not nal:
            return
        kind = nal[0] & 0x1F
        if kind == 7:
            self.sps = nal
        elif kind == 8:
            self.pps = nal
        self.nals.append(nal)

    def feed(self, pkt: bytes) -> List[Frame]:
        out: List[Frame] = []
        if len(pkt) < 13 or pkt[0] >> 6 != 2:
            return out
        self.packets += 1
        csrc_count = pkt[0] & 0x0F
        marker = bool(pkt[1] & 0x80)
        seq, ts = struct.unpack(">HI", pkt[2:8])
        off = 12 + 4 * csrc_count
        if pkt[0] & 0x10:  # header extension
            if len(pkt) < off + 4:
                return out
            off += 4 + 4 * struct.unpack(">H", pkt[off + 2:off + 4])[0]
        end = len(pkt)
        if pkt[0] & 0x20:  # padding
            end -= pkt[-1]
        payload = pkt[off:end]
        if not payload:
            return out

        ssrc = pkt[8:12]
        if self.ssrc is not None and ssrc != self.ssrc:
            # A different RTP stream (the receiver rebuilt its pipeline): start over.
            self.nals, self.fu, self.ts, self.last_seq = [], None, None, None
            self.broken, self.need_key = False, True
        self.ssrc = ssrc

        gap = self.last_seq is not None and seq != (self.last_seq + 1) & 0xFFFF
        if gap:
            self.lost += 1
            self.broken = True
            self.fu = None
        self.last_seq = seq

        if self.ts is not None and ts != self.ts:
            # New timestamp: the previous frame is over (its marker packet may have been lost).
            done = self._finish()
            if done:
                out.append(done)
            self.ts = None
        kind = payload[0] & 0x1F
        if gap and self.ts is None:
            # The missing packets may belong to the frame starting here, so it is dropped too,
            # unless it visibly starts from its beginning: the receiver puts the parameter sets
            # (SPS) in front of every key frame, so a key frame is never thrown away because
            # of a loss before it. That keeps "new connection" and "rotation" recoverable.
            starts_clean = kind == 7 or (kind == 24 and len(payload) > 3 and payload[3] & 0x1F == 7)
            self.broken = not starts_clean
        self.ts = ts

        if 1 <= kind <= 23:                       # one NAL unit
            self._add(payload)
        elif kind == 24:                          # STAP-A: several small NAL units
            i = 1
            while i + 2 <= len(payload):
                n = struct.unpack(">H", payload[i:i + 2])[0]
                self._add(payload[i + 2:i + 2 + n])
                i += 2 + n
        elif kind == 28 and len(payload) > 2:     # FU-A: one NAL unit in pieces
            start, stop = payload[1] & 0x80, payload[1] & 0x40
            if start:
                self.fu = bytearray([(payload[0] & 0xE0) | (payload[1] & 0x1F)])
            if self.fu is not None:
                self.fu += payload[2:]
                if stop:
                    self._add(bytes(self.fu))
                    self.fu = None
            elif not start:
                self.broken = True                # middle of a NAL whose start never arrived

        if marker:
            done = self._finish()
            self.ts = None
            if done:
                out.append(done)
        return out


def pack_frame(data: bytes, ts90k: int, key: bool, arrived_ms: Optional[int] = None) -> bytes:
    """One frame on the page's stream: 21-byte header (see HEADER) followed by the Annex B data.
    An empty payload is a keep-alive."""
    if arrived_ms is None:
        arrived_ms = int(time.time() * 1000)
    return HEADER.pack(len(data), FLAG_KEY if key else 0, (ts90k * 1000) // 90, arrived_ms) + data
