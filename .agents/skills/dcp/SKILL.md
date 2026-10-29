---
name: dcp
description: >-
  Save this chat session to agy_chat_history/, create or update agy_as_built.txt, create or update agy_CLAUDE.md,
  and create or update agy_.gitignore. NEVER modifies existing Claude-created docs (chat_history/, as_built.txt,
  CLAUDE.md, .gitignore) and NEVER runs any git commands. Use when the user says to save/export the chat and
  document updates (e.g. "/dcp", "dcp:", "save this chat").
---

# dcp — Antigravity document (no git, `agy_` prefix only)

Run these four steps in order in the active workspace root (`<workspace_root>`).

## Strict Rules
1. **NEVER alter existing Claude-created documentation files:**
   - Do **NOT** create, edit, or delete files inside `chat_history/`.
   - Do **NOT** edit `as_built.txt`, `CLAUDE.md`, or `.gitignore` (you may only **read** them as a read-only baseline if the `agy_` counterpart does not exist yet).
   - Every file or folder written by this skill **MUST** use the `agy_` prefix:
     - `agy_chat_history/<timestamp>_agy_chat_history.txt`
     - `agy_as_built.txt`
     - `agy_CLAUDE.md`
     - `agy_.gitignore`
2. **This skill NEVER runs git commands:**
   - No `git init`, `git add`, `git status`, `git commit`, `git push`, or any other `git` invocation. The user handles all git/GitHub operations themselves.

---

## 1. Save the chat transcript (`agy_chat_history/`)

Determine the current local timestamp in `ddMMyyHHmm` format (day, month, 2-digit year, 24-hour hour, minute — no separators) from `<ADDITIONAL_METADATA>` or via PowerShell (`Get-Date -Format "ddMMyyHHmm"`).

Write the **entire current conversation** (from its start through this `/dcp` invocation) to a new file at:

`<workspace_root>/agy_chat_history/<timestamp>_agy_chat_history.txt`

If `agy_chat_history/` doesn't exist yet, create it automatically via `write_to_file`. Look at any existing files in `agy_chat_history/` (or read-only in `chat_history/`) first to match their tone, and use this structure:

```text
================================================================================
AGY CHAT HISTORY EXPORT — <YYYY-MM-DD>
Session: <one-line description of what this session was about>
================================================================================

NOTE ON REDACTIONS: <only include this paragraph if the session actually
involved a live secret/credential/token pasted into the chat; describe what
was redacted and why. Omit the whole paragraph entirely if nothing needed
redacting — don't imply redactions happened when they didn't.>

--------------------------------------------------------------------------------
USER:
<summarize the user's message(s) — condense long instructions to their
substance, but keep specifics like file paths, numbers, and decisions intact>

--------------------------------------------------------------------------------
ASSISTANT:
<summarize what was actually done: key findings, tool calls and their outcomes,
questions asked and the answers given, files changed, anything published or
pushed. Write it as narrative prose, not a transcript dump — condense large
tool outputs to their substantive findings rather than reproducing them
verbatim. Preserve the back-and-forth order.>

--------------------------------------------------------------------------------
<continue alternating USER / ASSISTANT sections, separated by the dashed rule,
for the rest of the session>

================================================================================
END OF EXPORT
================================================================================
```

### Security check (mandatory, before writing the file)

Before writing anything to disk, scan the **entire** conversation content you are about to write — every turn, not just the most recent one, including text inside quoted tool output, code blocks, error messages, and file contents that may have echoed a secret — for anything that must never be committed to a (potentially public) repo. This is a hard gate: do not proceed to write the file until this pass is done. Look for things like:

- Passwords / passphrases
- API keys, tokens, bearer tokens, auth headers
- Private keys / certificates (`-----BEGIN ... KEY-----` blocks, `.pem`/`.key` contents, etc.)
- Connection strings / database URIs with embedded credentials
- Session cookies / session IDs
- Cloud or service credentials (AWS access keys, service account JSON, OAuth client secrets, etc.)
- Any other value that looks like a live secret the user pasted into the chat

Replace each finding with a descriptive `[REDACTED_*]` placeholder (e.g. `[REDACTED_API_KEY]`, `[REDACTED_PASSWORD]`) and note it in the "NOTE ON REDACTIONS" paragraph. Never write a real secret into the file, even partially or truncated. If nothing was found, omit the redactions paragraph entirely — don't imply redactions happened when they didn't.

---

## 2. Create or update `agy_as_built.txt`

`<workspace_root>/agy_as_built.txt` is the Antigravity-maintained living, factual inventory of what currently exists in the project — distinct from `agy_CLAUDE.md` (dev-facing conventions/gotchas) and from `agy_chat_history/` (per-session narrative logs). **Never modify `as_built.txt`.**

- If `agy_as_built.txt` doesn't exist yet:
  - If `as_built.txt` exists, read `as_built.txt` (read-only) as your baseline and write `agy_as_built.txt` updated with any changes from this session.
  - Otherwise, create `agy_as_built.txt` from scratch using the structure below.
- If `agy_as_built.txt` already exists, update it in place (`replace_file_content` or `write_to_file` with `Overwrite: true`) to reflect the current reality — add new components this session introduced, edit or remove entries that changed or are no longer true, and bump the "Last updated" line.
- If `agy_as_built.txt` already exists and nothing this session did changes the project's actual built state, skip this step silently rather than making a cosmetic edit.

Structure:

```text
================================================================================
AGY AS-BUILT — <project name>
Last updated: <YYYY-MM-DD>
================================================================================

SCRIPTS
- <path> — <one or two lines: what it does>.
  Requires: <env vars / config it needs, and where they live — e.g. ".env">

EXTERNAL INTEGRATIONS
- <service name> (<host/URL>) — <how it's accessed, e.g. "REST API">,
  credential in <location, e.g. ".env", "gitignored">

DATA STORES
- <table/db/file — what it holds, naming pattern if dynamic>

AUTOMATIONS / ROUTINES
- <name> (<what runs it — cron, cloud routine, manual>) — <what it does>
================================================================================
```

### Security rule (same hard gate as step 1)

Never write an actual secret value into `agy_as_built.txt` — only note *where* a credential lives (e.g. "in `.env`, gitignored").

---

## 3. Create or update `agy_CLAUDE.md`

**Never modify `CLAUDE.md`.**

- If `<workspace_root>/agy_CLAUDE.md` doesn't exist yet:
  - If `CLAUDE.md` exists, read `CLAUDE.md` (read-only) as the baseline and create `agy_CLAUDE.md` incorporating any new architecture, endpoints, tables, conventions, or gotchas introduced in this session.
  - If `CLAUDE.md` doesn't exist, write a concise `agy_CLAUDE.md` reflecting what's known about the project from this session and the repo as it stands — non-obvious architecture, how to build/run/test it, key conventions and gotchas.
- If `agy_CLAUDE.md` already exists, check whether anything done in this session makes it inaccurate or incomplete: new/removed/renamed scripts or commands, changes to the data pipeline or architecture, new env vars or setup steps, new conventions or gotchas. If an update is warranted, edit `agy_CLAUDE.md` directly. If no update is needed, skip silently rather than making a cosmetic edit.

---

## 4. Create or update `agy_.gitignore` (NO git commands, do NOT edit `.gitignore`)

Do **not** run any git command in this step, and do **not** modify `.gitignore`.

1. Read `.gitignore` (if present, read-only) and `agy_.gitignore` (if present) using `view_file`.
   - If `agy_.gitignore` doesn't exist yet, create it (starting from `.gitignore`'s entries if `.gitignore` exists, or covering at minimum `node_modules/`, `.env`/`*.env`, service-account JSON keys, `*.pem`, `*.key`, `*token*.txt`, `*creds*.txt`, `secrets/`, plus any sensitive files visible in the working tree).
   - If `agy_.gitignore` already exists, check whether any sensitive file this session introduced (or visible in the working tree) isn't yet covered, and add patterns for it to `agy_.gitignore`. If everything sensitive is already covered, leave `agy_.gitignore` as is.
2. Security gate (independent of the step-1 transcript scan): look over the files in the working tree for anything that looks like a live credential or an obviously sensitive file. If such a file is **not** covered by `.gitignore` / `agy_.gitignore`, flag it clearly to the user so they don't accidentally commit it — and add its pattern to `agy_.gitignore`. Never write a secret value into `agy_.gitignore`, `agy_as_built.txt`, `agy_CLAUDE.md`, or the `agy_chat_history/` file.
3. Report back:
   - The `agy_chat_history/<timestamp>_agy_chat_history.txt` file path
   - Whether `agy_as_built.txt`, `agy_CLAUDE.md`, and `agy_.gitignore` were each created / updated / left alone (and confirm that `chat_history/`, `as_built.txt`, `CLAUDE.md`, and `.gitignore` were untouched)
   - An explicit reminder that you did **not** commit or push — the user does that themselves.
