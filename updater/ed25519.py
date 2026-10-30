"""Minimal Ed25519 verification (RFC 8032) in pure Python.

The box updater must verify release signatures with zero third-party
dependencies, so this implements just the verify half of Ed25519 using
hashlib's SHA-512 and Python big integers. Verification only — signing
happens on the release machine, never on the box.
"""
import hashlib

_q = 2 ** 255 - 19
_l = 2 ** 252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _q - 2, _q) % _q
_I = pow(2, (_q - 1) // 4, _q)


def _xrecover(y):
    xx = (y * y - 1) * pow(_d * y * y + 1, _q - 2, _q)
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q != 0:
        x = (x * _I) % _q
    if x % 2 != 0:
        x = _q - x
    return x


_By = (4 * pow(5, _q - 2, _q)) % _q
_Bx = _xrecover(_By)
B = [_Bx % _q, _By % _q]


def _edwards(P, Q):
    x1, y1 = P
    x2, y2 = Q
    t = _d * x1 * x2 * y1 * y2 % _q
    x3 = (x1 * y2 + x2 * y1) * pow(1 + t, _q - 2, _q) % _q
    y3 = (y1 * y2 + x1 * x2) * pow(1 - t, _q - 2, _q) % _q
    return [x3, y3]


def _scalarmult(P, e):
    Q = [0, 1]
    while e > 0:
        if e & 1:
            Q = _edwards(Q, P)
        P = _edwards(P, P)
        e >>= 1
    return Q


def _decodeint(s):
    return int.from_bytes(s, "little")


def _decodepoint(s):
    if len(s) != 32:
        raise ValueError("bad point length")
    y = _decodeint(s) & (2 ** 255 - 1)
    sign = (s[31] >> 7) & 1
    x = _xrecover(y)
    if (x & 1) != sign:
        x = _q - x
    return [x, y]


def verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """True iff `signature` is a valid Ed25519 signature of `message`
    under `public_key` (raw 32-byte key, 64-byte signature). Never raises."""
    try:
        if len(public_key) != 32 or len(signature) != 64:
            return False
        A = _decodepoint(public_key)
        R = _decodepoint(signature[:32])
        S = _decodeint(signature[32:])
        if S >= _l:
            return False
        h = int.from_bytes(
            hashlib.sha512(signature[:32] + public_key + message).digest(),
            "little") % _l
        # The Ed25519 equation: [S]B == R + [h]A
        left = _scalarmult(B, S)
        right = _edwards(R, _scalarmult(A, h))
        return left[0] == right[0] and left[1] == right[1]
    except Exception:
        return False
