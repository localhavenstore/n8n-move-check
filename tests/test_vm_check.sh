#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2071,SC2088  # variables are used inside eval'd checks; HHMM is compared as zero-padded strings
# Move Kit - free move-check on a THROWAWAY VM (testvm.sh: Ubuntu 24.04) with a REAL npm install of n8n, started by
# MODE=systemd (EnvironmentFile) | pm2 (ecosystem file + 'pm2 startup' unit) | manual (nohup) | npx (npx n8n@version),
# SQLite, imported workflows (Execute Command, Function = removed in 3.0, Read/Write Files), a local community package.
# Checks M1 (read-only: user folder files + every stable database table hashed, same n8n process; no secret printed),
# M2 (detection of how it runs), the detection items, and that Pro's plan refuses manual/npx installs.
# Writes tests/VM_CHECK_RESULT-<mode>.txt. Not 03:15-04:05 (backup window).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); VM=${TESTVM:?set TESTVM to your throwaway-VM helper script}
N8N_VERSION=${N8N_VERSION:-2.41.5}; NODE_VERSION=${NODE_VERSION:-24.21.0}; MODE=${MODE:-systemd}
[[ $MODE =~ ^(systemd|pm2|manual|npx)$ ]] || { echo "MODE=systemd|pm2|manual|npx"; exit 2; }
# npx users have NO global n8n (npx would just run a global one): in npx mode every n8n command goes through npx
N8N=n8n; [[ $MODE == npx ]] && N8N="npx -y n8n@$N8N_VERSION"
KEY=mk-test-key-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n'); FP=$(printf %s "$KEY" | sha256sum | cut -c1-12)
SECRET_ENV=mk-env-secret-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')
URLPW=mk-url-pw-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
LOG=$HERE/VM_CHECK_RESULT-$MODE.txt; : > "$LOG"
say() { echo "$*" | tee -a "$LOG"; }
q() { $VM ssh "$@" 2>&1; }
PASS=0; FAILS=0
check() { if eval "$2"; then say "ok   $1"; PASS=$((PASS + 1)); else say "FAIL $1"; FAILS=$((FAILS + 1)); fi; }
h=$(date +%H%M); if [[ $h > 0315 && $h < 0405 ]]; then echo "backup window - not now"; exit 3; fi
trap '$VM down >/dev/null 2>&1' EXIT
say "== n8n Move Check VM test $(date -Is) - n8n $N8N_VERSION, Node $NODE_VERSION, $MODE + SQLite"
$VM up >>"$LOG" 2>&1 || { say "VM up failed"; say "OVERALL: FAIL"; exit 1; }
for f in "$HERE/../free/move-check.js" "$HERE/../pro/n8n-move.js" "$HERE/../pro/compare.js" "$HERE/fixtures/workflows.json"; do $VM put "$f" "/home/learner/$(basename "$f")"; done
q "lsb_release -ds" >> "$LOG"
q "sudo apt-get -qq update >/dev/null; sudo DEBIAN_FRONTEND=noninteractive apt-get -qq install -y sqlite3 build-essential python3 >/dev/null 2>&1; sqlite3 --version   # npm builds isolated-vm (needs a compiler)" >> "$LOG"
# Node from nodejs.org (checksum-verified) + n8n from npm, both REAL, run by a dedicated user
q "set -e; cd /tmp; curl -fsSLO https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz
   curl -fsSL https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt | grep ' node-v$NODE_VERSION-linux-x64.tar.xz\$' | sha256sum -c -
   sudo tar -C /usr/local --strip-components=1 -xJf node-v$NODE_VERSION-linux-x64.tar.xz; node --version" >> "$LOG"
[[ $MODE != npx ]] && q "for t in 1 2 3; do sudo npm install -g --no-audit --no-fund n8n@$N8N_VERSION $([[ $MODE == pm2 ]] && echo pm2) >/tmp/npm.log 2>&1 && break; sleep 20; done; tail -2 /tmp/npm.log; n8n --version" >> "$LOG"
q "sudo useradd -m -s /bin/bash n8nuser; if [ $MODE = npx ]; then cd /tmp; sudo -u n8nuser -H $N8N --version >/tmp/npx-first.log 2>&1; echo npx-first-rc=\$?; grep -v 'npm warn\|npm notice' /tmp/npx-first.log | tail -3; fi" >> "$LOG"
q "set -e; sudo install -d -o n8nuser -g n8nuser /home/n8nuser/.n8n /home/n8nuser/data
   printf 'N8N_ENCRYPTION_KEY=$KEY\nN8N_PORT=5678\nGENERIC_TIMEZONE=Europe/(redacted)\nN8N_SECURE_COOKIE=false\nNODES_EXCLUDE=[]\nMY_API_SECRET=$SECRET_ENV\nWEBHOOK_URL=http://hookuser:$URLPW@localhost:5678/\n' | sudo tee /etc/n8n.env >/dev/null
   sudo -u n8nuser mkdir -p /home/n8nuser/.n8n-files
   sudo chmod 600 /etc/n8n.env
   sudo -u n8nuser mkdir -p /home/n8nuser/.n8n/nodes/node_modules/n8n-nodes-demo /home/n8nuser/.n8n/nodes/node_modules/fake-native/build/Release
   echo '{\"name\":\"n8n-nodes-demo\",\"version\":\"0.1.0\",\"n8n\":{\"nodes\":[]}}' | sudo -u n8nuser tee /home/n8nuser/.n8n/nodes/node_modules/n8n-nodes-demo/package.json >/dev/null
   echo '{\"dependencies\":{\"n8n-nodes-demo\":\"0.1.0\"}}' | sudo -u n8nuser tee /home/n8nuser/.n8n/nodes/package.json >/dev/null
   sudo -u n8nuser touch /home/n8nuser/.n8n/nodes/node_modules/fake-native/build/Release/addon.node
   sudo cp /home/learner/workflows.json /home/n8nuser/wf.json; sudo chown n8nuser /home/n8nuser/wf.json
   cd /tmp; sudo -u n8nuser -H env \$(sudo cat /etc/n8n.env | xargs) $N8N import:workflow --input=/home/n8nuser/wf.json >/tmp/imp.log 2>&1 || tail -3 /tmp/imp.log
   case $MODE in
   systemd) printf '[Unit]\nDescription=n8n\nAfter=network.target\n[Service]\nUser=n8nuser\nEnvironmentFile=/etc/n8n.env\nExecStart=/usr/local/bin/n8n start\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n' | sudo tee /etc/systemd/system/n8n.service >/dev/null
     sudo systemctl daemon-reload; sudo systemctl enable --now n8n >/dev/null 2>&1 ;;
   pm2) sudo python3 -c \"import json; e=dict(l.split('=',1) for l in open('/etc/n8n.env').read().splitlines() if '=' in l); open('/home/n8nuser/ecosystem.config.js','w').write('module.exports = '+json.dumps({'apps':[{'name':'n8n','script':'/usr/local/bin/n8n','args':'start','env':e}]})+';')\"
     sudo chown n8nuser /home/n8nuser/ecosystem.config.js; sudo chmod 600 /home/n8nuser/ecosystem.config.js
     sudo -u n8nuser -H bash -c 'cd ~ && pm2 start ecosystem.config.js >/dev/null && pm2 save >/dev/null'
     sudo env PATH=\$PATH:/usr/local/bin pm2 startup systemd -u n8nuser --hp /home/n8nuser >/dev/null; sudo -u n8nuser -H pm2 kill >/dev/null; sudo systemctl start pm2-n8nuser ;;
   manual) sudo bash -c 'set -a; . /etc/n8n.env; set +a; cd /home/n8nuser; nohup sudo -E -u n8nuser -H /usr/local/bin/n8n start > /tmp/n8n-run.log 2>&1 &' ;;
   npx) sudo bash -c 'set -a; . /etc/n8n.env; set +a; cd /home/n8nuser; nohup sudo -E -u n8nuser -H npx -y n8n@$N8N_VERSION start > /tmp/n8n-run.log 2>&1 &' ;;
   esac
   for i in \$(seq 1 200); do curl -fs localhost:5678/healthz >/dev/null && break; sleep 3; done; curl -s localhost:5678/healthz; echo" >> "$LOG"
# SETUP must really work, or the test stops (no vacuous passes)
mainpid() { q "pgrep -u n8nuser -o -f '/n8n( start)?\$'" | tail -1; }   # the n8n main process (not pm2, npm exec or the task runner)
v=$(q "cd /tmp && sudo -u n8nuser -H $N8N --version" | tail -1);  hz=$(q "curl -s localhost:5678/healthz"); mp=$(mainpid); args=$(q "ps -o args= -p $mp")
check "SETUP real npm install: n8n --version = $N8N_VERSION" '[[ "$v" == "$N8N_VERSION" ]]'
check "SETUP n8n running ($MODE) and healthy" '[[ "$hz" == *ok* && "$mp" =~ ^[1-9][0-9]*$ ]] && { [[ $MODE != npx ]] || [[ "$args" == *_npx/* ]]; }'
if (( FAILS > 0 )); then say "setup failed - stopping"; say "OVERALL: FAIL"; exit 1; fi
# M1 baseline: every file of the user folder except the live database + logs, and every STABLE table of the database
TABLES="workflow_entity credentials_entity shared_workflow shared_credentials project project_relation user webhook_entity tag_entity workflows_tags variables folder"
state() { q "sudo find /home/n8nuser/.n8n -type f ! -name '*.log' ! -name 'database.sqlite*' ! -path '*/.cache/*' -exec sha256sum {} + | sort | sha256sum
  for t in $TABLES; do sudo sqlite3 /home/n8nuser/.n8n/database.sqlite \"select * from \$t order by 1\" 2>/dev/null | sha256sum | sed \"s/^/\$t /\"; done"; }
before=$(state); pid_before=$(mainpid)
# run the check as root (sudo) and as the n8n user
q "cd /tmp && sudo node /home/learner/move-check.js > /tmp/out-root.txt 2>&1; sudo cp move-report.json /tmp/report-root.json; stat -c %a move-report.json > /tmp/report-mode; sudo chmod 644 /tmp/report-root.json /tmp/out-root.txt"
q "sudo cp /home/learner/move-check.js /home/n8nuser/; sudo chown n8nuser /home/n8nuser/move-check.js; sudo -u n8nuser sh -c 'cd /home/n8nuser && node move-check.js' > /tmp/out-user.txt 2>&1; sudo chmod 644 /tmp/out-user.txt"
OUT=$(q "cat /tmp/out-root.txt"); REP=$(q "cat /tmp/report-root.json"); OUTU=$(q "cat /tmp/out-user.txt")
echo "$OUT" | sed 's/^/   | /' >> "$LOG"
after=$(state); pid_after=$(mainpid)
echo "$before" | sed 's/^/   before | /' >> "$LOG"
check "M1 read-only: user folder files + every stable database table unchanged ($(wc -w <<< "$TABLES") tables)" '[[ "$before" == "$after" && $(grep -c "^workflow_entity " <<< "$before") == 1 ]]'
check "M1 no service restarted (same n8n PID)" '[[ "$pid_before" == "$pid_after" && -n "$pid_before" ]]'
check "M1 no secret in output/report (key, env secret, password inside WEBHOOK_URL)" '! grep -q -- "$KEY\|$SECRET_ENV\|$URLPW" <<< "$OUT$REP$OUTU"'
check "report file is private (mode 600)" '[[ $(q "cat /tmp/report-mode") == 600 ]]'
case $MODE in
  systemd) check "M2 detects systemd + the unit name" 'grep -q "started by systemd (n8n.service)" <<< "$OUT"' ;;
  pm2)     check "M2 detects pm2 (also when pm2 itself runs under pm2-n8nuser.service)" 'grep -q "\[run\] pm2:" <<< "$OUT" && ! grep -q "started by systemd" <<< "$OUT"' ;;
  manual)  check "M2 detects a hand-started n8n" 'grep -q "started by hand" <<< "$OUT"' ;;
  npx)     check "M2 detects npx" 'grep -q "started with npx" <<< "$OUT"' ;;
esac
check "detects the n8n version ($N8N_VERSION)" 'grep -q "n8n $N8N_VERSION on Node" <<< "$OUT"'
check "key fingerprint = sha256(key)[:12] ($FP)" 'grep -q "fingerprint $FP" <<< "$OUT" && grep -q "\"key_fingerprint\": \"$FP\"" <<< "$REP"'
check "env var NAMES listed, secret value not; WEBHOOK_URL shown without its password" 'grep -q "N8N_ENCRYPTION_KEY" <<< "$OUT" && grep -q "N8N_PORT=5678" <<< "$OUT" && grep -q "WEBHOOK_URL=http://\*\*\*@localhost:5678/" <<< "$OUT"'
check "workflow count (3)" 'grep -q "3 workflows" <<< "$OUT"'
check "1.0.4: trigger node id > 36 chars reported (issue #40606; INFO on SQLite), non-trigger long id NOT reported" 'l=$(grep "#40606" <<< "$OUT"); grep -q "Shell backup" <<< "$l" && ! grep -q "File writer" <<< "$l"'
check "Execute Command flagged with its command (ffmpeg)" 'grep -q "Execute Command runs INSIDE the container.*ffmpeg" <<< "$OUT"'
check "Function node = 3.0 blocker by workflow name" 'grep -q "BLOCKER.*Function node is removed in 3.0 - used in: Legacy function flow" <<< "$OUT"'
check "host paths INSIDE Execute Command flagged (/home/n8nuser/data/in.mp4)" 'grep -q "host paths used in Execute Command: .*/home/n8nuser/data/in.mp4" <<< "$OUT"'
check "host file path flagged (/home/n8nuser/data)" 'grep -q "/home/n8nuser/data" <<< "$OUT"'
check "community node package listed (n8n-nodes-demo)" 'grep -q "n8n-nodes-demo" <<< "$OUT"'
check "3.0 default: unverified packages off named (N8N_UNVERIFIED_PACKAGES_ENABLED)" 'grep -q "DECIDE.*N8N_UNVERIFIED_PACKAGES_ENABLED changes from true to false in 3.0.*n8n-nodes-demo" <<< "$OUT"'
check "3.0 timeout line cites the breaking-changes page" 'grep -q "300 s to 60 s in 3.0 (n8n v3.0 breaking-changes page)" <<< "$OUT"'
check "community package with native code = blocker (fake-native)" 'grep -q "BLOCKER.*native code: fake-native" <<< "$OUT"'
check "Node requirement reported from n8n's own package.json" 'grep -q "satisfies n8n.s requirement (>=24" <<< "$OUT"'
check "~/.n8n-files flagged as outside the user folder" 'grep -q "file folder /home/n8nuser/.n8n-files .*OUTSIDE the user folder" <<< "$OUT"'
check "NODES_EXCLUDE noted (must go into the Docker settings)" 'grep -q "NODES_EXCLUDE is set" <<< "$OUT"'
check "non-1000 uid of the n8n user flagged (container user)" 'grep -q "n8n runs as n8nuser (uid [0-9]*).*uid 1000" <<< "$OUT"'
check "SQLite found" 'grep -q "SQLite /home/n8nuser/.n8n/database.sqlite" <<< "$OUT"'
check "as the n8n user (no sudo) it still reports key + workflows" 'grep -q "fingerprint $FP" <<< "$OUTU" && grep -q "3 workflows" <<< "$OUTU"'
if [[ $MODE == manual || $MODE == npx ]]; then
  PL=$(q "cd /home/learner && sudo SUDO_USER=learner node n8n-move.js plan; echo rc=\$?")
  echo "$PL" | sed 's/^/   pro plan | /' >> "$LOG"
  check "Pro plan refuses a $MODE install with the reason (nothing written)" 'grep -q "STOP: n8n was started $([[ $MODE == npx ]] && echo "with npx" || echo "by hand")" <<< "$PL" && grep -q "rc=1" <<< "$PL" && [[ $(q "sudo test -e /home/learner/n8n-docker/plan.json && echo y || echo n") == n ]]'
fi
say "PASS $PASS  FAIL $FAILS"
[[ $FAILS == 0 ]] && say "OVERALL: PASS" || say "OVERALL: FAIL"
