#!/usr/bin/env python3
"""Add clearly attributed, removable demo tasks to an explicitly chosen workspace.

No jobs, prompts, installations, or unrelated user records are changed. Removal
moves only the tasks from this script's manifest to recoverable Trash, children
first, and archives its project/tag. Keep the manifest for cleanup.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import uuid
from local_api import open_local

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    connection = json.loads((workspace / "connection.json").read_text())
    manifest_path = workspace / "demo-manifest.json"

    def api(path, body=None, method=None):
        with open_local(connection, "/api" + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method or ("POST" if body is not None else "GET"),
            headers={"Authorization": "Bearer " + connection["token"],
                     "Content-Type": "application/json", "X-Sift-Actor": "sift-demo", "X-Sift-Request": "1"},
        ) as response:
            return json.load(response)

    snapshot = api("/snapshot")
    if args.remove:
        manifest = json.loads(manifest_path.read_text())
        tasks = [t for t in snapshot["tasks"] if t["id"] in manifest["tasks"]]
        for task in sorted(tasks, key=lambda t: not bool(t["parentId"])):
            if task["deletedAt"] or task["mergedInto"]:
                continue
            task["deletedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
            api("/tasks/" + task["id"], {"task": task, "expectedRevision": task["revision"],
                "reason": "Remove the explicitly authorized Sift demo data", "requestId": str(uuid.uuid4())}, "PUT")
        for kind in ("project", "tag"):
            entity = next((e for e in snapshot[kind + "s"] if e["id"] == manifest[kind]), None)
            if entity:
                api("/" + kind + "s", {**entity, "archived": True})
        print("Demo tasks moved to recoverable Trash; demo project and tag archived.")
        return

    def entity(kind, name, color):
        existing = next((e for e in snapshot[kind + "s"] if e["name"] == name and not e["archived"]), None)
        if existing:
            if not manifest_path.exists():
                raise RuntimeError(f"An unrelated {name!r} already exists; refusing to reuse it")
            return existing["id"]
        return api("/" + kind + "s", {"name": name, "color": color, "icon": "folder", "archived": False})["id"]

    project = entity("project", "Sift demo", "green")
    tag = entity("tag", "Demo · removable", "rose")
    manifest = {"project": project, "tag": tag, "tasks": [], "workspace": str(workspace)}
    today = dt.datetime.now(dt.timezone.utc).date()

    def task(key, title, status="open", priority="none", parent="", focus=True, due="", icon="circle-check", checklist=None):
        record = {"title": title, "status": status, "priority": priority, "parentId": parent,
            "today": focus, "dueDate": due, "icon": icon, "project": project, "tags": [tag],
            "description": "**Demo task — safe to edit.**\n\nThis is sample content for exploring Sift, not a claim that work has been performed.\n\n- Open task details to try Markdown and the checklist.\n- Change status, priority, or dates. Every saved change has a history.\n- All demo content belongs to **Sift demo** and can be removed later.",
            "source": "sift-demo", "sourceKey": "demo-v1:" + key,
            "attachments": [], "checklist": checklist or []}
        saved = api("/tasks", {"task": record, "expectedRevision": 0,
            "reason": "User-authorized demo content for visual exploration", "requestId": "sift-demo-v1:" + key})["task"]
        manifest["tasks"].append(saved["id"])
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        return saved["id"]

    parent = task("workspace", "Make room for the week ahead", "progress", "high", icon="calendar",
        checklist=[{"id": "demo-check-1", "title": "Choose one useful next step", "done": True},
                   {"id": "demo-check-2", "title": "Leave a little breathing room", "done": False}])
    task("priorities", "Choose three priorities", "done", parent=parent)
    task("notes", "Bring loose notes into one place", parent=parent, icon="file-text")
    task("reading", "Read the research notes", priority="medium", due=str(today), icon="search")
    task("review", "Review the desktop and mobile layouts", "progress", "high", icon="palette")
    task("capture", "Capture an idea before it disappears", icon="bulb")
    task("long", "Check how a longer task title wraps without hiding the important next action", priority="low", icon="file-text")
    task("complete", "Try completing and reopening a task", "done", icon="circle-check")
    task("backlog", "Keep a promising idea for later", focus=False, icon="bulb")
    task("due", "Make time for a follow-up", priority="urgent", due=str(today-dt.timedelta(days=1)), icon="calendar")
    print(f"Added {len(manifest['tasks'])} labeled demo tasks. Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
