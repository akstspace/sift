#!/usr/bin/env python3
"""Non-billable Pi RPC peer for the chat panel's tests.

It keeps one conversation per --session-id in --session-dir, streams replies
the way Pi does, and acts out scenarios named in the message:

  sift-op   runs `sift tasks add` through bash and reports the JSON result
  demo      runs real Sift commands (from the appended guide) and other tools,
            pacing its stream like a model so the UI can be reviewed
  ask       asks the person to choose, then replies with the answer
  slow      streams until aborted
  fail      ends the reply with a provider error
  crash     exits mid-reply
  anything else is echoed back
"""
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time

args = sys.argv[1:]
def flag(name, default=""):
    return args[args.index(name) + 1] if name in args else default

session_dir, session_id = flag("--session-dir"), flag("--session-id")
if os.getenv("PI_CHAT_RECORD_ARGS"):
    with open(os.environ["PI_CHAT_RECORD_ARGS"], "a", encoding="utf-8") as f:
        f.write(json.dumps(args) + "\n")
if os.getenv("PI_CHAT_FAIL_START"):
    print("Pi fixture refused to start", file=sys.stderr, flush=True)
    sys.exit(3)

path = os.path.join(session_dir, session_id + ".json") if session_dir and session_id else ""
messages, broken = [], False
if path and os.path.exists(path):
    try:
        messages = json.load(open(path, encoding="utf-8"))
    except ValueError:
        broken = True

lock = threading.Lock()
state = {"model": {"provider": "fixture", "id": "fixture-model", "name": "Fixture model", "reasoning": True},
         "thinking": "medium", "streaming": False, "abort": threading.Event(), "queue": []}
answers, waiting = {}, {}

def send(data):
    with lock:
        print(json.dumps(data), flush=True)

def save():
    if path:
        os.makedirs(session_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(messages, f)

def now():
    return int(time.time() * 1000)

def ask(request):
    ev = threading.Event()
    waiting[request["id"]] = ev
    send(dict(request, type="extension_ui_request"))
    ev.wait()
    return answers.pop(request["id"])

def assistant(text="", thinking="", tool=None, stop="stop", error=None):
    content = []
    if thinking:
        content.append({"type": "thinking", "thinking": thinking})
    if text:
        content.append({"type": "text", "text": text})
    if tool:
        content.append({"type": "toolCall", "id": tool["id"], "name": tool["name"], "arguments": tool["args"]})
    m = {"role": "assistant", "content": content, "stopReason": stop, "timestamp": now(),
         "provider": state["model"]["provider"], "model": state["model"]["id"]}
    if error:
        m["errorMessage"] = error
    return m

def stream(text, thinking=""):
    send({"type": "message_start", "message": assistant(stop="pending")})
    index = 0
    if thinking:
        send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_start", "contentIndex": index}})
        send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": index, "delta": thinking}})
        send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_end", "contentIndex": index, "content": thinking}})
        index += 1
    for word in text.split(" "):
        send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": index, "delta": word + " "}})

def finish(aborted=False):
    send({"type": "turn_end", "message": messages[-1], "toolResults": []})
    send({"type": "agent_end", "messages": messages[-3:], "willRetry": False})
    save()
    state["streaming"] = False
    send({"type": "agent_settled", "aborted": aborted})

def reply(text, images):
    state["streaming"], state["abort"] = True, threading.Event()
    send({"type": "agent_start"})
    send({"type": "turn_start"})
    user = {"role": "user", "content": [{"type": "text", "text": text}] + images, "timestamp": now()}
    messages.append(user)
    send({"type": "message_start", "message": user})
    send({"type": "message_end", "message": user})
    plain = text.rsplit("</sift-context>", 1)[-1].strip()
    if plain == "crash":
        os._exit(7)
    if plain == "slow":
        send({"type": "message_start", "message": assistant(stop="pending")})
        while not state["abort"].wait(0.05):
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "still working "}})
        messages.append(assistant("still working", stop="aborted", error="Request was aborted"))
        send({"type": "message_end", "message": messages[-1]})
        return finish(aborted=True)
    if plain == "fail":
        send({"type": "message_start", "message": assistant(stop="pending")})
        messages.append(assistant(stop="error", error='429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}'))
        send({"type": "message_end", "message": messages[-1]})
        return finish()
    if plain == "ask":
        choice = ask({"id": "dlg_choose", "method": "select", "title": "Allow dangerous command?", "options": ["Allow", "Block"]})
        answer = "cancelled" if choice.get("cancelled") else choice.get("value")
        stream("You chose " + str(answer))
        messages.append(assistant("You chose " + str(answer)))
        send({"type": "message_end", "message": messages[-1]})
        return finish()
    if plain == "sift-op":
        tool = {"id": "call_add", "name": "bash", "args": {"command": "sift tasks add --title 'Pay rent' --actor chat"}}
        stream("Adding it.", thinking="The person wants a task.")
        messages.append(assistant("Adding it.", thinking="The person wants a task.", tool=tool, stop="toolUse"))
        send({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_end", "contentIndex": 2, "toolCall": {"type": "toolCall", "id": tool["id"], "name": tool["name"], "arguments": tool["args"]}}})
        send({"type": "message_end", "message": messages[-1]})
        send({"type": "tool_execution_start", "toolCallId": tool["id"], "toolName": "bash", "args": tool["args"]})
        output = json.dumps({"task": {"id": "task_1", "title": "Pay rent", "status": "open", "revision": 1}, "potentialDuplicates": []})
        send({"type": "tool_execution_update", "toolCallId": tool["id"], "toolName": "bash", "args": tool["args"], "partialResult": {"content": [{"type": "text", "text": "x" * 9000}]}})
        send({"type": "tool_execution_end", "toolCallId": tool["id"], "toolName": "bash", "durationMs": 12, "isError": False,
              "result": {"content": [{"type": "text", "text": output}], "details": {"big": "y" * 100}}})
        result = {"role": "toolResult", "toolCallId": tool["id"], "toolName": "bash", "content": [{"type": "text", "text": output + "\n" + "z" * 20000}], "isError": False, "timestamp": now(), "details": {"big": True}}
        messages.append(result)
        send({"type": "message_start", "message": result})
        send({"type": "message_end", "message": result})
        send({"type": "turn_end", "message": messages[-2], "toolResults": [result]})
        send({"type": "turn_start"})
        stream("Added Pay rent.")
        messages.append(assistant("Added Pay rent."))
        send({"type": "message_end", "message": messages[-1]})
        return finish()
    stream("Echo: " + plain, thinking="Thinking about it.")
    messages.append(assistant("Echo: " + plain, thinking="Thinking about it."))
    send({"type": "message_end", "message": messages[-1]})
    finish()

guide = flag("--append-system-prompt")
sift_cli = re.search(r'Use the Sift CLI as "(.+?)" --data "(.+?)"', guide)

def tool(call_id, name, args, run_it, pause=0.25):
    """Announces a tool call, runs it, and reports the result as Pi does."""
    m = assistant(tool={"id": call_id, "name": name, "args": args}, stop="toolUse")
    send({"type": "message_start", "message": assistant(stop="pending")})
    send({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_start", "contentIndex": 0, "id": call_id, "toolName": name}})
    time.sleep(0.1)
    send({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_end", "contentIndex": 0, "toolCall": {"type": "toolCall", "id": call_id, "name": name, "arguments": args}}})
    messages.append(m)
    send({"type": "message_end", "message": m})
    send({"type": "tool_execution_start", "toolCallId": call_id, "toolName": name, "args": args})
    started = time.time()
    time.sleep(pause)
    output, error = run_it()
    result = {"role": "toolResult", "toolCallId": call_id, "toolName": name, "content": [{"type": "text", "text": output}], "isError": error, "timestamp": now()}
    send({"type": "tool_execution_end", "toolCallId": call_id, "toolName": name, "durationMs": int((time.time() - started) * 1000), "isError": error, "result": {"content": result["content"]}})
    messages.append(result)
    send({"type": "message_start", "message": result})
    send({"type": "message_end", "message": result})

def bash(command):
    def go():
        # Commands are this fixture's own Sift CLI calls; no shell is involved.
        p = subprocess.run(shlex.split(command), capture_output=True, text=True, timeout=30)
        out = (p.stdout + p.stderr).strip()
        if p.returncode:
            out += "\n\nCommand exited with code %d" % p.returncode
        return out, p.returncode != 0
    return go

def say(text, thinking="", delay=0.025):
    send({"type": "message_start", "message": assistant(stop="pending")})
    index = 0
    if thinking:
        send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_start", "contentIndex": 0}})
        for word in thinking.split(" "):
            send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": word + " "}})
            time.sleep(delay)
        send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_end", "contentIndex": 0, "content": thinking}})
        index = 1
    for word in re.split(r"(?<= )", text):
        send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": index, "delta": word}})
        time.sleep(delay)
    messages.append(assistant(text, thinking=thinking))
    send({"type": "message_end", "message": messages[-1]})

def demo(cli):
    exe, data = cli.group(1), cli.group(2)
    sift = '"%s" --data "%s" ' % (exe, data)
    say("Let me look at what's on your plate first.", thinking="The person wants their day organized. I'll read the tasks, add the passport renewal, and close out anything finished.")
    tool("call_list", "bash", {"command": sift + "tasks list"}, bash(sift + "tasks list"))
    tasks = json.loads(bash(sift + "tasks list")()[0] or "[]")
    send({"type": "turn_end"}); send({"type": "turn_start"})
    tool("call_dupes", "bash", {"command": sift + "tasks duplicates --title 'Renew passport'"}, bash(sift + "tasks duplicates --title 'Renew passport'"))
    tool("call_add", "bash", {"command": sift + "tasks add --title 'Renew passport' --today --priority high --due-date 2026-11-14 --actor chat"},
         bash(sift + "tasks add --title 'Renew passport' --today --priority high --due-date 2026-11-14 --actor chat"))
    open_tasks = [t for t in tasks if t.get("status") != "done" and not t.get("deletedAt")]
    if open_tasks:
        t = open_tasks[0]
        cmd = sift + "tasks update %s --revision %d --status done --reason 'Paid this morning' --actor chat" % (t["id"], t["revision"])
        tool("call_done", "bash", {"command": cmd}, bash(cmd))
    cmd = sift + "tasks update task_missing --revision 1 --title Nope --actor chat"
    tool("call_fail", "bash", {"command": cmd}, bash(cmd))
    tool("call_read", "read", {"path": os.path.expanduser("~/Notes/passport.md")}, lambda: ("# Passport\nExpires 2026-12-01\nForm DS-82 needed\n", False), 0.4)
    tool("call_ls", "bash", {"command": "ls -1 ~/Documents | head -5"}, lambda: ("Invoices\nNotes\nPhotos\nReceipts\nTaxes", False), 0.3)
    tool("call_edit", "edit", {"path": os.path.expanduser("~/Notes/passport.md"), "oldText": "Form DS-82 needed", "newText": "Form DS-82 needed\nPhoto booked for Thursday"}, lambda: ("Edited 1 place", False), 0.2)
    say("Done. Here's where things stand:\n\n- Added **Renew passport** for today, due Nov 14, marked high priority.\n- Marked one finished task as done.\n- One update failed because that task doesn't exist, so I left it alone.\n\n| Next | When |\n|---|---|\n| Fill in form DS-82 | Today |\n| Passport photo | Thursday |\n\nWant me to set a reminder for the photo?")
    finish()

def run(text, images):
    # The chat's guide names the CLI; a scheduled job's prompt does.
    cli = sift_cli or re.search(r'Use "(.+?)" --data "(.+?)" for the local task CLI', text)
    if text.rsplit("</sift-context>", 1)[-1].strip().endswith("demo") and cli:
        state["streaming"], state["abort"] = True, threading.Event()
        send({"type": "agent_start"}); send({"type": "turn_start"})
        user = {"role": "user", "content": [{"type": "text", "text": text}], "timestamp": now()}
        messages.append(user)
        send({"type": "message_start", "message": user}); send({"type": "message_end", "message": user})
        return demo(cli)
    reply(text, images)
    while state["queue"]:
        reply(state["queue"].pop(0), [])
        send({"type": "queue_update", "steering": state["queue"], "followUp": []})

send({"type": "extension_ui_request", "id": "status_1", "method": "setStatus", "statusKey": "fixture", "statusText": "Fixture ready"})
if os.getenv("PI_CHAT_STARTUP_DIALOG"):
    threading.Thread(target=lambda: ask({"id": "dlg_startup", "method": "confirm", "title": "Trust this folder?", "timeout": 60000}), daemon=True).start()

for line in sys.stdin:
    c = json.loads(line)
    kind, data, error = c["type"], {}, None
    if kind == "extension_ui_response":
        if c["id"] in waiting:
            answers[c["id"]] = c
            waiting.pop(c["id"]).set()
        continue
    if kind == "get_state":
        data = {"model": state["model"], "thinkingLevel": state["thinking"], "isStreaming": state["streaming"], "sessionId": session_id}
    elif kind == "get_messages":
        if broken:
            error = "Session file is not valid JSON"
        data = {"messages": messages}
    elif kind == "get_commands":
        data = {"commands": [{"name": "skill:review", "description": "Review changes", "source": "skill"},
                             {"name": "todo", "description": "Show todos", "source": "extension"}]}
    elif kind == "get_available_models":
        data = {"models": [state["model"], {"provider": "fixture", "id": "other-model", "name": "Other model", "reasoning": False}]}
    elif kind == "get_available_thinking_levels":
        data = {"levels": ["off", "low", "medium", "high"] if state["model"].get("reasoning") else ["off"]}
    elif kind == "set_model":
        if c.get("modelId") == "missing":
            error = "Model not found: fixture/missing"
        else:
            state["model"] = {"provider": c["provider"], "id": c["modelId"], "name": c["modelId"], "reasoning": c["modelId"] != "other-model"}
            data = state["model"]
    elif kind == "set_thinking_level":
        state["thinking"] = c["level"]
    elif kind == "abort":
        state["abort"].set()
    elif kind == "clear_queue":
        data = {"steering": state["queue"], "followUp": []}
        state["queue"] = []
    elif kind == "prompt":
        if os.getenv("PI_CHAT_RECORD_PROMPTS"):
            with open(os.environ["PI_CHAT_RECORD_PROMPTS"], "a", encoding="utf-8") as f:
                f.write(json.dumps(c) + "\n")
        if state["streaming"]:
            if not c.get("streamingBehavior"):
                error = "Agent is already streaming; specify streamingBehavior"
            else:
                state["queue"].append(c["message"])
                send({"type": "queue_update", "steering": state["queue"], "followUp": []})
                data = {"disposition": "queued"}
        else:
            data = {"disposition": "started"}
            state["streaming"] = True
    send({"type": "response", "id": c.get("id"), "command": kind, "success": error is None, "data": data, "error": error})
    if kind == "prompt" and data.get("disposition") == "started":
        threading.Thread(target=run, args=(c["message"], c.get("images") or []), daemon=True).start()
