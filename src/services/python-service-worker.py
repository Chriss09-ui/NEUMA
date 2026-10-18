"""Trusted worker. Application code receives scoped capabilities through its host."""
import asyncio
import importlib.util
import inspect
import json
import os
import re
import sys
from types import SimpleNamespace

entrypoint, dependencies = sys.argv[1:3]
sys.path.insert(0, os.path.dirname(entrypoint))
if dependencies:
    sys.path.insert(0, dependencies)
protocol_out = sys.stdout
sys.stdout = sys.stderr
active = None
sequence = 0
loaded = None

def send(value):
    protocol_out.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    protocol_out.flush()

def call(capability, args=None):
    global sequence
    if active is None:
        raise RuntimeError("request_finished")
    sequence += 1
    call_id = "call_" + str(sequence)
    send({"type": "call", "requestId": active, "id": call_id, "capability": capability, "args": args if args is not None else {}})
    response = json.loads(sys.stdin.readline())
    if response.get("type") != "reply" or response.get("id") != call_id or response.get("requestId") != active:
        raise RuntimeError("invalid_reply")
    if not response.get("ok"):
        raise RuntimeError(response.get("reason", "capability_failed"))
    return response.get("value")

def group(name, methods):
    return SimpleNamespace(**{method: (lambda args=None, cap=name + "." + method: call(cap, args)) for method in methods})

ctx = SimpleNamespace(connection=group("connection", ["call", "readResult"]), state=group("state", ["get", "set"]),
                      files=group("files", ["list", "read", "write"]), material=group("material", ["list", "read", "image"]),
                      web=group("web", ["search", "fetch"]), model=group("model", ["call"]),
                      progress=lambda value: send({"type": "progress", "requestId": active, "value": value}))
try:
    spec = importlib.util.spec_from_file_location("neuma_application", entrypoint)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
except Exception:
    sys.stderr.write("service_module_load_failed\n")
    sys.exit(1)
send({"type": "ready", "protocolVersion": 1})
for line in sys.stdin:
    try:
        message = json.loads(line)
        if message.get("type") == "health":
            send({"type": "health", "id": message.get("id"), "ok": True})
            continue
        if message.get("type") != "run" or message.get("protocolVersion") != 1:
            raise RuntimeError("invalid_request")
        active = message["requestId"]
        if loaded is None:
            spec = importlib.util.spec_from_file_location("neuma_application", entrypoint)
            loaded = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(loaded)
        action = getattr(loaded, "actions", {}).get(message["actionId"])
        if callable(action):
            result = action(message.get("input"), ctx)
        else:
            result = loaded.run({"actionId": message["actionId"], "input": message.get("input")}, ctx)
        if inspect.isawaitable(result):
            result = asyncio.run(result)
        send({"type": "result", "requestId": active, "ok": True, "value": result})
    except Exception as error:
        reason = getattr(error, "reason", "action_failed")
        if not isinstance(reason, str) or not re.fullmatch(r"[a-z_]{1,80}", reason):
            reason = "action_failed"
        send({"type": "result", "requestId": active, "ok": False, "error": "action_failed", "reason": reason})
    finally:
        active = None
