#!/usr/bin/env python3
"""Non-billable deterministic Pi RPC peer for lifecycle acceptance tests."""
import json
import os
import sys
import threading

if "--version" in sys.argv:
    print("fixture-1.0")
    sys.exit(0)

lock = threading.Lock()
stopped = threading.Event()
model = {"provider": "fixture", "id": "fixture-model"}

def send(data):
    with lock:
        print(json.dumps(data), flush=True)

def emit(scenario):
    if scenario == "exit":
        os._exit(0)
    if scenario == "approval":
        send({"type": "extension_ui_request", "method": "confirm", "title": "Approve write?"})
        return
    if scenario == "hang":
        stopped.wait()
        return
    send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "delta": "Checking the "}})
    send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "delta": "fixture notes."}})
    send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "Fixture evidence."}})
    send({"type": "tool_execution_start", "toolCallId": "call_read", "toolName": "read", "args": {"path": "notes.md", "content": "x" * 5000}})
    send({"type": "tool_execution_end", "toolCallId": "call_read", "toolName": "read", "durationMs": 42,
          "result": {"content": [{"type": "text", "text": "line one\n" * 3000}, {"type": "image", "data": "AAAA", "mimeType": "image/png"}]},
          "isError": scenario == "tool-error"})
    if scenario in ("auth", "failed"):
        send({"type": "message_end", "message": {"role": "assistant", "stopReason": "error", "errorMessage": "Authentication required" if scenario == "auth" else "Upstream network failure"}})
    if scenario == "maintenance":
        for kind in ("auto_retry_start", "auto_compaction_start", "auto_compaction_end"):
            send({"type": kind})
    send({"type": "agent_end"})
    # Acceptance/agent_end must not finish the run before agent_settled.
    if not stopped.wait(0.15):
        send({"type": "agent_settled", "aborted": scenario == "aborted"})

for line in sys.stdin:
    c = json.loads(line)
    kind = c["type"]
    data = {}
    success = True
    if kind == "get_state":
        data = {"model": None if os.getenv("PI_FIXTURE_NO_MODEL") else model}
    elif kind == "get_available_models":
        data = {"models": [dict(model, name="Fixture model")]}
    elif kind == "get_available_thinking_levels":
        data = {"levels": ["off", "high"]}
    elif kind == "set_model":
        success = c.get("modelId") != "missing"
    elif kind == "prompt":
        if os.getenv("PI_FIXTURE_PROMPT_RECORD"):
            with open(os.environ["PI_FIXTURE_PROMPT_RECORD"], "w", encoding="utf-8") as record:
                json.dump(c, record)
        scenario = c["message"].rsplit("scenario:", 1)[-1].strip()
        data = {"disposition": "handled" if scenario == "handled" else "accepted"}
    elif kind == "abort":
        stopped.set()
    if kind == os.getenv("PI_FIXTURE_FAIL"):
        success = False
    if kind == os.getenv("PI_FIXTURE_HANG"):
        if os.getenv("PI_FIXTURE_COMMAND_RECORD"):
            with open(os.environ["PI_FIXTURE_COMMAND_RECORD"], "w", encoding="utf-8") as record:
                record.write(kind)
        stopped.wait()
        continue
    send({"type": "response", "id": c["id"], "command": kind, "success": success, "data": data, "error": "Model unavailable" if not success else None})
    if kind == "prompt" and scenario != "handled":
        threading.Thread(target=emit, args=(scenario,), daemon=True).start()
stopped.set()
