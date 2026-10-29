---
name: q
description: >-
  Answer a question in read-only / investigate-only mode — never edit, write, deploy, or mutate anything.
  Use when the user prefixes a query with "question/no action needed", "q:", runs /q, or otherwise just wants
  an explanation or diagnosis (how/why/which/what is…) with no changes made.
---

# q — question / no action needed

The user wants an **answer**, not a change. Investigate as deeply as needed, then
explain. Make **zero** modifications to anything — no code edits, no file writes,
no git operations, no deploys, no data mutations, no external messages.

## Allowed (read-only investigation)
- Read / search / explore over the codebase (`view_file`, `grep_search`, `find_by_name`, `list_dir`, `read_url_content`, `search_web`).
- Read-only shell via `run_command`: `cat` / `Get-Content`, `ls` / `Get-ChildItem`, `git log` / `git show` / `git status` / `git diff`, `curl` **only** for `GET` or an explicitly read-only/idempotent status check.
- Read-only MCP calls: Supabase `execute_sql` with **SELECT-only** queries, `list_*` / `get_*` / `describe` tools, ActiveCampaign/Xero/Fathom/Drive reads, `search_docs`, etc.
- Opening/reading files the user points at.

## Forbidden (no action — this is the whole point of /q)
- `write_to_file`, `replace_file_content`, `multi_replace_file_content`, or any file creation/modification/deletion via shell or tools.
- `git add` / `commit` / `push` / `rebase` / `reset`, branch changes.
- Deploys (`gcloud run deploy`, `supabase functions deploy`, etc.).
- **Invoking/firing edge functions or cron jobs**, `POST` / `PUT` / `PATCH` / `DELETE` requests, any `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` / DDL, `apply_migration`, `create_*` / `update_*` / `delete_*` / `deploy_*` / `add_*` / `send_*` MCP tools.
- Sending email/chat/messages, creating docs/artifacts, scheduling routines (`schedule`).

## How to answer
1. Do the read-only digging required to answer **accurately** — don't guess. Verify claims against the code / live data (`CLAUDE.md`, `GEMINI.md`, memory, and schema can be stale; a `SELECT` or a file read is ground truth).
2. Give a direct, concise answer first, then the supporting evidence (`file:line`, row counts, query results) that backs it.
3. If answering well would genuinely require a mutating action (e.g. "fire the sync so I can see if it fixes X"), **stop and ask** — describe what you'd run and let the user explicitly request it. Never take the action under `/q`.

If the user later says to go ahead and do something, that cancels the no-action constraint for that follow-up request.
