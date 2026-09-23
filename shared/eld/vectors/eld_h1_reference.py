#!/usr/bin/env python3
"""
An independent reference implementation of the LeaseOS ELD canonical form (eld-h1), and the
generator of the golden vectors in eld-h1.vectors.json.

It shares no code with the TypeScript implementation. The canonical form's rules (see
shared/eld/eldEvent.ts) are a strict subset of what Python's json module produces with
sort_keys=True, separators=(",", ":"), ensure_ascii=False — sorted keys by code point, the seven
short escapes plus \\u00xx lowercase for other controls, everything else raw UTF-8, integers as
plain decimals — so the standard library is the reference and nothing here is hand-rolled.

Run:  python3 shared/eld/vectors/eld_h1_reference.py > shared/eld/vectors/eld-h1.vectors.json
"""
import hashlib, json, sys

HASH_VERSION = "eld-h1"
KEYS = [
    "hashVersion", "deviceRef", "eventRef", "deviceSequence", "eventType", "eventCode", "dutyStatus", "recordOrigin", "eventAtMs",
    "eventUtcOffsetMinutes", "unitNumber", "latitudeE7", "longitudeE7", "locationAccuracyMm", "locationSource", "jurisdiction",
    "odometerM", "engineHoursMillis", "vehicleSpeedKphMillis", "annotation", "supersedesEventRef",
]


def canonical(value) -> str:
    for v in walk(value):
        if isinstance(v, float):
            raise ValueError("floats are forbidden in canonical form")
        if isinstance(v, int) and not isinstance(v, bool) and abs(v) > 9007199254740991:
            raise ValueError("integer exceeds 2^53-1")
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def walk(v):
    yield v
    if isinstance(v, dict):
        for x in v.values():
            yield from walk(x)
    elif isinstance(v, list):
        for x in v:
            yield from walk(x)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_event(device_ref: str, e: dict) -> dict:
    out = {k: e.get(k) for k in KEYS}
    out["hashVersion"] = HASH_VERSION
    out["deviceRef"] = device_ref
    out["eventRef"] = e["eventRef"].lower()
    if out["supersedesEventRef"] is not None:
        out["supersedesEventRef"] = out["supersedesEventRef"].lower()
    return out


def event_hashes(device_ref: str, e: dict):
    text = canonical(canonical_event(device_ref, e))
    payload = sha256(text)
    prev = e.get("previousEventHash") or ""
    event = sha256(f"{HASH_VERSION}\n{prev}\n{payload}")
    return text, payload, event


DEV = "DEV-MFJ2K1A0-Q7ZP"
R1 = "5d3a2b7c-9e1f-4a6b-8c0d-1e2f3a4b5c6d"
R2 = "0a1b2c3d-4e5f-4061-8283-94a5b6c7d8e9"
R3 = "ffffffff-eeee-4ddd-bccc-bbbbbbbbbbbb"

MINIMAL = {"eventRef": R1, "deviceSequence": 0, "eventType": "engine_power_up", "recordOrigin": "automatic",
           "eventAtMs": 1789135200000, "previousEventHash": None}

COMPLETE = {"eventRef": R2, "deviceSequence": 41, "eventType": "duty_status_change", "eventCode": "DS_ON", "dutyStatus": "on_duty",
            "recordOrigin": "driver", "eventAtMs": 1789135260123, "eventUtcOffsetMinutes": -360, "unitNumber": "VAC-27",
            "latitudeE7": 535044210, "longitudeE7": -1134909000, "locationAccuracyMm": 4200, "locationSource": "gps",
            "jurisdiction": "CA-AB", "odometerM": 120450500, "engineHoursMillis": 8123400, "vehicleSpeedKphMillis": 0,
            "annotation": "Pre-trip complete, leaving yard", "supersedesEventRef": None,
            "previousEventHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}


def ev(**patch):
    e = dict(MINIMAL)
    e.update(patch)
    return e


EVENT_VECTORS = [
    ("minimal event", "the six required fields; every optional field encodes as null", DEV, MINIMAL),
    ("complete event", "every participating field set, with a predecessor hash", DEV, COMPLETE),
    ("explicit nulls equal absence", "optional fields set to null must produce the minimal event's bytes",
     DEV, ev(eventCode=None, dutyStatus=None, unitNumber=None, latitudeE7=None, annotation=None, supersedesEventRef=None)),
    ("empty string annotation", "an empty string is a value, distinct from null", DEV, ev(eventType="annotation", annotation="")),
    ("unicode", "accented, BMP symbol and an astral code point, all raw UTF-8", DEV, ev(eventType="annotation", annotation="Départ à Montréal ☃ 🚚")),
    ("quotation mark", "U+0022 escaped as backslash-quote", DEV, ev(eventType="annotation", annotation='He said "stop"')),
    ("backslash", "U+005C escaped as two backslashes", DEV, ev(eventType="annotation", annotation="C:\\logs\\eld")),
    ("control characters", "tab, newline, CR, U+0001, U+001F short and \\u escapes; DEL raw", DEV,
     ev(eventType="annotation", annotation="a\tb\nc\rd\x01e\x1ff\x7fg")),
    ("line separators raw", "U+2028 and U+2029 are not escaped", DEV, ev(eventType="annotation", annotation="x\u2028y\u2029z")),
    ("negative coordinate", "southern and western hemisphere, fixed scale E7", DEV,
     ev(eventType="location_observation", latitudeE7=-337000000, longitudeE7=-1512000000, locationSource="gps")),
    ("positive coordinate", "northern and eastern hemisphere, fixed scale E7", DEV,
     ev(eventType="location_observation", latitudeE7=647500000, longitudeE7=1250000000, locationSource="network")),
    ("coordinate bounds", "the extreme legal values encode as plain integers", DEV,
     ev(eventType="location_observation", latitudeE7=900000000, longitudeE7=-1800000000, locationAccuracyMm=0)),
    ("timestamp", "eventAtMs is an integer; the offset travels separately", DEV, ev(eventAtMs=1789135200999, eventUtcOffsetMinutes=330)),
    ("timestamp range edges", "the storable minimum and maximum", DEV, ev(eventAtMs=2147483647000, eventUtcOffsetMinutes=-840)),
    ("predecessor hash", "the same payload as the minimal event, chained: payloadHash equal, eventHash different", DEV,
     ev(previousEventHash="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")),
    ("correction", "a correction names the event it supersedes", DEV,
     ev(eventRef=R3, deviceSequence=42, eventType="correction", supersedesEventRef=R2, annotation="on duty began 13:45",
        previousEventHash="9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")),
    ("uppercase uuid normalizes", "an uppercase eventRef and supersedesEventRef hash as lowercase", DEV,
     ev(eventRef=R3.upper(), deviceSequence=42, eventType="correction", supersedesEventRef=R2.upper())),
    ("large integers", "2^53-1 and a maximal sequence encode as plain decimals", DEV,
     ev(deviceSequence=9007199254740991, odometerM=9007199254740991, engineHoursMillis=1)),
    ("other device", "the same event on another device is another record", "DEV-OTHER-0001", MINIMAL),
]

VALUE_VECTORS = [
    ("nested object, unsorted input", "keys sorted by code point at every depth", {"z": 1, "a": {"y": None, "b": [1, 2, 3], "c": {"k": True}}, "m": "x"}),
    ("array order preserved", "arrays are semantic order; never sorted", {"list": [3, 1, 2, None, False, "b", "a", [2, 1], {"y": 0, "x": 0}]}),
    ("empty containers", "an empty object and an empty array", {"o": {}, "a": []}),
    ("key ordering by code point", "ASCII digits before uppercase before lowercase; prefix first", {"b": 1, "B": 2, "1": 3, "a": 4, "aa": 5, "A": 6}),
    ("booleans and null", "the three literals", [True, False, None]),
    ("integers", "zero, negative, and the largest magnitude", [0, -1, 9007199254740991, -9007199254740991]),
    ("escapes", "every short escape, a \\u escape, DEL and non-ASCII raw", "\"\\\b\t\n\f\r\x00\x1f\x7f\u00e9\u20ac\U0001f69a"),
    ("empty string", "two quotation marks", ""),
]


def main():
    out = {
        "hashVersion": HASH_VERSION,
        "generatedBy": "shared/eld/vectors/eld_h1_reference.py (Python json module as the independent reference)",
        "eventVectors": [],
        "valueVectors": [],
    }
    for name, desc, dev, e in EVENT_VECTORS:
        text, payload, event = event_hashes(dev, e)
        out["eventVectors"].append({"name": name, "description": desc, "deviceRef": dev, "input": e,
                                    "canonical": text, "canonicalUtf8Length": len(text.encode("utf-8")),
                                    "payloadHash": payload, "eventHash": event})
    for name, desc, v in VALUE_VECTORS:
        text = canonical(v)
        out["valueVectors"].append({"name": name, "description": desc, "value": v, "canonical": text,
                                    "canonicalUtf8Length": len(text.encode("utf-8")), "sha256": sha256(text)})
    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
