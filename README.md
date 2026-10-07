# n8n Move Check

n8n 3.0 will no longer support installs that run with `npm` or `npx`. n8n says to move to Docker **before** upgrading
(see n8n's v3.0 breaking-changes page; n8n's own step-by-step migration guide was announced as "coming soon" when this
was written - use it when it is out).

**Move Check** is one read-only script that tells you what *your* move involves, before you touch anything.

Doing the move by hand? The free step-by-step guide - encryption key, permissions, same version first, checks:
https://localhavenstore.github.io/guides/n8n-npm-to-docker.html

```
sudo node move-check.js
```

It does not modify n8n or its data, restarts nothing and prints no secret. It writes `move-report.json` (also without secrets) into the current folder.

## What it reports

Each line is `OK`, `INFO`, `DECIDE` (you have to choose something) or `BLOCKER` (fix this first).

- How n8n runs: systemd (unit name), pm2 (also when pm2 itself is started by `pm2 startup`), started by hand, or with
  `npx` - and that the old one should be *stopped, not removed* until the Docker one is verified
- n8n and Node versions; n8n's own Node requirement (n8n 2.41.5 needs Node 24 - `n8n --version` still answers on
  Node 22, but `n8n start` refuses)
- The **encryption key**: where it is (environment or `~/.n8n/config`) and a 12-character fingerprint, never the key.
  The Docker n8n needs exactly this key - credentials encrypted with the original key cannot be decrypted with a different key
- n8n settings in its environment (names only; a few harmless values like the port and time zone)
- The user folder and the database (SQLite file size, or Postgres host + database name)
- n8n's file folder `~/.n8n-files` (n8n 2.x default for Read/Write Files) - it is **outside** the user folder, so it
  does not move with it
- `NODES_EXCLUDE` (in n8n 2.x it is how Execute Command gets enabled) - it must go into the Docker settings too
- The Linux user n8n runs as - the official image runs as uid 1000; if yours differs, host folders need the same uid
- Workflows using **Execute Command** (the first word of each command - it must exist inside the container), files read
  or written on the host (those folders must be mounted), community nodes installed and used, and community packages
  with **native code** (built for your system - they may not run in the official image: platform, architecture or a needed rebuild)
- A binary-data folder set with `N8N_BINARY_DATA_STORAGE_PATH` outside the user folder
- n8n 3.0 blockers by workflow name: the 36 node types that are gone in the n8n v3 release-candidate image
  (`v3-rc-20261005`, compared with 2.41.5 - Function, Function Item, Cron, Interval, Item Lists, Read Binary File(s),
  Read PDF, Convert to/from binary data, legacy OpenAI and 21 legacy AI/LangChain nodes), removed Code-node helpers,
  and 3.0 setting changes (removed variables, `N8N_DEFAULT_BINARY_DATA_MODE=default`, the 60 s Code-node timeout, unverified community packages off by default)
- Free disk space for a copy plus a backup, and whether Docker is installed

## Changes in 1.0.2 (6 Oct 2026)
- n8n 3.0 new defaults from n8n's official v3.0 breaking-changes page: if you have community packages installed, the check now
  names `N8N_UNVERIFIED_PACKAGES_ENABLED` (true -> false in 3.0) and says when to set it; the Code-step timeout note
  (`N8N_RUNNERS_TASK_TIMEOUT` 300 -> 60 s) cites the page. Re-tested on throw-away VMs (systemd, pm2, manual, npx).

## Changes in 1.0.1 (6 Oct 2026)
The removed-node list now comes from the n8n v3 RC image itself (36 types, AI Transform reported as INFO - n8n
converts it to Code); new 3.0 setting checks. Re-tested on the VM (systemd, 23/23).

## Tested

On throwaway Ubuntu 24.04 VMs with a **real** npm install of n8n 2.41.5 (`npm install -g n8n`, pinned to that version)
on Node 24.21.0, SQLite, started four ways: systemd (`EnvironmentFile`), pm2 (with `pm2 startup`), by hand, and with
`npx` (pinned to the same version). Each time: read-only (every file
of the user folder and 12 database tables - workflows, credentials, sharing, projects, users, webhooks, tags, variables,
folders - unchanged, same n8n process), no secret in the output or the report (planted test secrets, including a
password inside `WEBHOOK_URL`), the report file private (mode 600), and the items above detected for these SQLite setups (the Postgres paths are tested with the paid kit). Also run as the n8n
user without sudo. The test script is in this repository (`tests/test_vm_check.sh`). Not tested: other distributions,
WSL2, other n8n versions. The community-package "verified" status is not checked (it needs n8n's online list) - check it
in n8n.

## Need the move itself?

**n8n Move Kit Pro** does the move with an automatic check and one-command rollback: same n8n version in Docker, data
copied (never moved) and checked, every credential decrypted inside the container as a check, active workflows and
webhooks compared, your old install only stopped - and never two n8n at once, also after a reboot. For n8n run by
systemd or pm2; tested with SQLite and Postgres.
Link: https://localhavenstore.gumroad.com/l/n8n-move-kit

## Licence

MIT - see LICENSE. No warranty. Made with AI assistance and tested as above. Not affiliated with or endorsed by n8n GmbH; n8n is their trademark.


## Support

The tool is free and stays free. If it saved you time, you can leave a tip:
[![Tip on Ko-fi](https://img.shields.io/badge/Ko--fi-leave%20a%20tip-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/localhaven)
(optional - nothing is unlocked by it).
