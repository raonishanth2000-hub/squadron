/* ---------------------------------------------------------------------------
   Running other people's code on your own machine.

   Every snippet here is written by whoever is signed in, and this server can be
   reached from outside the machine when a tunnel is open — so the code is
   treated as hostile. Each run happens inside a throwaway directory under a
   macOS seatbelt profile that:

     · denies network access outright (no exfiltration, no callbacks)
     · denies reads of /Users and /var/root, so a C++ `#include "~/.ssh/id_rsa"`
       or a Python open() cannot pull anything private into the output
     · allows writes only inside that one run directory
     · caps CPU seconds and created-file size, and limits process count so a
       fork bomb cannot spread

   Wall-clock timers kill anything the CPU limit misses, and output is truncated
   rather than buffered without bound.

   Known gap: Darwin does not enforce RLIMIT_AS or RLIMIT_DATA, so a program can
   still allocate freely until the wall-clock timer fires. That is a local
   resource risk, not an escape or a disclosure risk.

   If sandbox-exec is not present, execution is refused rather than run
   unprotected — see `runnerStatus()`.
   --------------------------------------------------------------------------- */
import { spawn, execFileSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LANGS = {
  cpp:    { label: 'C++17',    ext: 'cpp', mono: 'cpp' },
  python: { label: 'Python 3', ext: 'py',  mono: 'python' }
};

const CAP        = 64 * 1024;   /* bytes of stdout/stderr kept */
const COMPILE_MS = 15000;
const RUN_MS     = 6000;
const CPU_S      = 5;
const SRC_MAX    = 200 * 1024;
const STDIN_MAX  = 64 * 1024;

/* Two sandboxes, one job. macOS has seatbelt; Linux has bubblewrap. Both are
   used the same way — wrap the compiler or interpreter so it cannot reach the
   network or anything on disk except its own scratch directory. */
const SANDBOX = '/usr/bin/sandbox-exec';                    /* macOS */
const BWRAP = ['/usr/bin/bwrap', '/bin/bwrap'].find(p => existsSync(p)) || null;  /* Linux */
const IS_MAC = process.platform === 'darwin';

/* /usr/bin/g++ and /usr/bin/python3 are Xcode shims: they try to write an
   xcrun cache into the system temp dir, which the sandbox denies, and the
   failure lands in the user's stderr on every single run. Resolve the real
   binaries once at boot and call those instead. */
function resolve(tool, fallback) {
  for (const probe of [['/usr/bin/xcrun', ['-f', tool]], ['/bin/sh', ['-lc', 'command -v ' + tool]]]) {
    try {
      const out = execFileSync(probe[0], probe[1], { encoding: 'utf8', timeout: 5000 }).trim();
      if (out && existsSync(out) && !out.startsWith('/usr/bin/')) return out;
      if (out && existsSync(out) && fallback === null) return out;
    } catch {}
  }
  return fallback;
}
const CXX = resolve('g++', '/usr/bin/g++');
const PY  = resolve('python3', '/usr/bin/python3');

export function runnerStatus() {
  if (process.env.SQUADRON_NO_RUN === '1')
    return { ok: false, reason: 'Running code is switched off on this server (SQUADRON_NO_RUN=1).' };
  if (IS_MAC) {
    if (!existsSync(SANDBOX)) return { ok: false, reason: 'sandbox-exec is missing, so code cannot be run safely here. Editing and sharing still work.' };
    return { ok: true, reason: '' };
  }
  if (process.platform === 'linux') {
    if (!BWRAP) return { ok: false, reason: 'bubblewrap is not installed, so code cannot be run safely here. Editing and sharing still work.' };
    return { ok: true, reason: '' };
  }
  return { ok: false, reason: 'This server has no sandbox for running code. Editing and sharing still work.' };
}

/* Apple clang ships no bits/stdc++.h, and every competitive template opens with
   it — so provide one inside the run directory rather than fail the build. */
const BITS = `#pragma once
#include <algorithm>
#include <array>
#include <bitset>
#include <cassert>
#include <cctype>
#include <chrono>
#include <climits>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <list>
#include <map>
#include <numeric>
#include <queue>
#include <random>
#include <set>
#include <sstream>
#include <stack>
#include <string>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
`;

const profileFor = (dir) => `(version 1)
(deny default)
(allow process-exec process-fork)
(allow sysctl-read mach-lookup signal)
(allow file-read*)
(deny file-read* (subpath "/Users") (subpath "/private/var/root"))
(allow file-read* file-write* (subpath "${dir}"))
(allow file-read* file-write* (subpath "/private${dir}"))
(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))
`;

/* The same rules the seatbelt profile above expresses, in bubblewrap's terms:
   no network at all, a read-only toolchain, and exactly one writable path.

   --unshare-all covers net, ipc, pid, uts, cgroup and user in one go. The
   toolchain comes in read-only through /usr, with the usual Ubuntu symlinks so
   the dynamic linker resolves. /etc is deliberately NOT bound — it holds
   /etc/shadow — and nothing in it turned out to be needed. */
const bwrapArgs = (dir) => [
  '--unshare-all',
  '--die-with-parent',      /* if the server dies, so does the program */
  '--new-session',          /* no stealing the controlling terminal */
  '--ro-bind', '/usr', '/usr',
  '--symlink', 'usr/lib', '/lib',
  '--symlink', 'usr/lib64', '/lib64',
  '--symlink', 'usr/bin', '/bin',
  '--symlink', 'usr/sbin', '/sbin',
  '--proc', '/proc',
  '--dev', '/dev',
  '--tmpfs', '/tmp',
  '--bind', dir, dir,       /* the only writable place in the whole filesystem */
  '--chdir', dir,
  '--'
];

function clip(buf, dir, cut) {
  let s = buf.toString('utf8');
  /* `cut` comes from the reader, which knows it threw a chunk away. Inferring
     it from the length alone missed the ordinary case: a pipe hands over 64KB
     in one go, the buffer lands on exactly CAP, `> CAP` is false, and the
     program's other 200KB vanished without a word. */
  if (s.length > CAP) { s = s.slice(0, CAP); cut = true; }
  if (cut) s += `\n… truncated at ${CAP / 1024} KB — the program printed more than this.`;
  /* compiler and traceback lines carry the throwaway directory; the person
     reading the output only cares about the file they wrote */
  if (dir) s = s.split('/private' + dir + '/').join('').split(dir + '/').join('');
  return s;
}

/* `sh -c '… exec "$@"' sh <argv>` applies the ulimits and then hands over
   without ever interpolating a path into a shell string. */
function sandboxed(profile, argv, { ms, cwd, stdin }) {
  return new Promise((resolve) => {
    /* No `ulimit -u`: on Darwin that is a per-USER process cap, so any value low
       enough to stop a fork bomb is already below the desktop's own process
       count and every spawn fails. Runaway children are handled by killing the
       whole process group below instead. */
    /* The ulimits apply either way — they are a kernel limit on the process,
       not a sandbox feature, and they are what stops a runaway loop and a
       program that tries to fill the disk. */
    const wrapper = IS_MAC
      ? [SANDBOX, '-f', profile, ...argv]
      : [BWRAP, ...bwrapArgs(cwd), ...argv];
    const child = spawn('/bin/sh', [
      '-c', `ulimit -t ${CPU_S} -f 8192 2>/dev/null; exec "$@"`, 'sh',
      ...wrapper
    ], {
      cwd, detached: true,   /* own process group, so the kill reaches grandchildren */
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: cwd, HOME: cwd, LC_ALL: 'C' }
    });

    const out = [], err = [];
    let outN = 0, errN = 0, done = false, timedOut = false, outCut = false, errCut = false;

    const finish = (code, signal) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ stdout: clip(Buffer.concat(out), cwd, outCut), stderr: clip(Buffer.concat(err), cwd, errCut),
                code, signal, timedOut });
    };
    const killAll = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; killAll(); }, ms);

    child.stdout.on('data', (d) => { if (outN < CAP) { out.push(d); outN += d.length; } else outCut = true; });
    child.stderr.on('data', (d) => { if (errN < CAP) { err.push(d); errN += d.length; } else errCut = true; });
    child.on('error', (e) => finish(-1, e.code || 'spawn-failed'));
    child.on('close', finish);

    if (child.stdin.writable) { child.stdin.end(stdin || ''); }
  });
}

/* Compile once, then run the same binary against every case. Recompiling per
   case would triple the wall time of a ten-case sweep for no reason. */
export async function runTests({ lang, source, cases, includes }) {
  const status = runnerStatus();
  if (!status.ok) return { ok: false, stage: 'blocked', stderr: status.reason, results: [] };
  const spec = LANGS[lang];
  if (!spec) return { ok: false, stage: 'blocked', stderr: 'Unsupported language.', results: [] };
  if (!Array.isArray(cases) || !cases.length)
    return { ok: false, stage: 'blocked', stderr: 'Add a test case first.', results: [] };

  const dir = await mkdtemp(join(tmpdir(), 'squadron-run-'));
  const started = Date.now();
  try {
    /* only seatbelt reads a profile file; bubblewrap takes its rules as arguments */
    const profile = join(dir, 'p.sb');
    if (IS_MAC) await writeFile(profile, profileFor(dir));
    const src = join(dir, 'main.' + spec.ext);
    await writeFile(src, source);
    const incDir = join(dir, 'inc');
    await mkdir(join(incDir, 'bits'), { recursive: true });
    await writeFile(join(incDir, 'bits', 'stdc++.h'), BITS);
    /* the squad's shared templates, written beside the source so a snippet can
       #include "dsu.h" and get the team's copy */
    for (const inc of includes || []) {
      const safe = String(inc.name || '').replace(/[^A-Za-z0-9._-]/g, '');
      if (!safe) continue;
      await writeFile(join(incDir, safe), String(inc.body || ''));
      await writeFile(join(dir, safe), String(inc.body || ''));
    }

    let runArgv;
    if (lang === 'cpp') {
      const bin = join(dir, 'prog');
      const c = await sandboxed(profile, [CXX, '-O1', '-std=c++17', '-w', '-I', incDir, '-o', bin, src],
        { ms: COMPILE_MS, cwd: dir, stdin: '' });
      if (c.code !== 0 || c.timedOut) {
        return { ok: false, stage: 'compile', stderr: c.timedOut ? 'Compiling timed out.' : (c.stderr || 'Compilation failed.'),
          ms: Date.now() - started, results: [] };
      }
      runArgv = [bin];
    } else {
      runArgv = [PY, src];
    }

    const results = [];
    for (const tc of cases.slice(0, 25)) {
      const r = await sandboxed(profile, runArgv, { ms: RUN_MS, cwd: dir, stdin: String(tc.stdin || '').slice(0, STDIN_MAX) });
      const got = r.stdout;
      const want = String(tc.expected ?? '');
      /* trailing whitespace is almost never the thing under test */
      const norm = (x) => x.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
      const expectedGiven = want.trim().length > 0;
      const passed = r.timedOut ? false : r.code === 0 && (!expectedGiven || norm(got) === norm(want));
      results.push({
        id: tc.id, name: tc.name || 'case',
        passed, timedOut: r.timedOut, exitCode: r.code,
        stdout: got, stderr: r.stderr, expected: want, checked: expectedGiven
      });
    }
    return {
      ok: results.every(r => r.passed), stage: 'run', ms: Date.now() - started,
      passed: results.filter(r => r.passed).length, total: results.length, results
    };
  } catch (e) {
    return { ok: false, stage: 'error', stderr: String(e && e.message || e), ms: Date.now() - started, results: [] };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runCode({ lang, source, stdin, includes }) {
  const status = runnerStatus();
  if (!status.ok) return { ok: false, stage: 'blocked', stdout: '', stderr: status.reason, ms: 0 };

  const spec = LANGS[lang];
  if (!spec) return { ok: false, stage: 'blocked', stdout: '', stderr: 'Unsupported language.', ms: 0 };
  if (typeof source !== 'string' || !source.trim())
    return { ok: false, stage: 'blocked', stdout: '', stderr: 'There is nothing to run.', ms: 0 };
  if (source.length > SRC_MAX)
    return { ok: false, stage: 'blocked', stdout: '', stderr: 'That file is too large to run.', ms: 0 };

  const input = String(stdin || '').slice(0, STDIN_MAX);
  const dir = await mkdtemp(join(tmpdir(), 'squadron-run-'));
  const started = Date.now();
  try {
    /* only seatbelt reads a profile file; bubblewrap takes its rules as arguments */
    const profile = join(dir, 'p.sb');
    if (IS_MAC) await writeFile(profile, profileFor(dir));
    const src = join(dir, 'main.' + spec.ext);
    await writeFile(src, source);

    for (const inc of includes || []) {
      const safe = String(inc.name || '').replace(/[^A-Za-z0-9._-]/g, '');
      if (!safe) continue;
      await mkdir(join(dir, 'inc'), { recursive: true });
      await writeFile(join(dir, 'inc', safe), String(inc.body || ''));
      await writeFile(join(dir, safe), String(inc.body || ''));
    }
    if (lang === 'cpp') {
      await mkdir(join(dir, 'inc', 'bits'), { recursive: true });
      await writeFile(join(dir, 'inc', 'bits', 'stdc++.h'), BITS);
      const bin = join(dir, 'prog');
      const c = await sandboxed(profile,
        [CXX, '-O1', '-std=c++17', '-w', '-I', join(dir, 'inc'), '-o', bin, src],
        { ms: COMPILE_MS, cwd: dir, stdin: '' });
      if (c.code !== 0 || c.timedOut) {
        return { ok: false, stage: 'compile', stdout: c.stdout,
          stderr: c.timedOut ? `Compiling took longer than ${COMPILE_MS / 1000}s.` : (c.stderr || 'Compilation failed.'),
          ms: Date.now() - started };
      }
      const r = await sandboxed(profile, [bin], { ms: RUN_MS, cwd: dir, stdin: input });
      return shape(r, started, c.stderr);
    }

    const r = await sandboxed(profile, [PY, src], { ms: RUN_MS, cwd: dir, stdin: input });
    return shape(r, started, '');
  } catch (e) {
    return { ok: false, stage: 'error', stdout: '', stderr: String(e && e.message || e), ms: Date.now() - started };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* A program killed by a signal writes nothing on its way out, so without these
   the output box was simply empty and the person had to guess. */
const SIGNAL_REASON = {
  SIGXCPU: `Used more than ${CPU_S} seconds of CPU — almost always an infinite loop.`,
  SIGKILL: `Stopped after ${RUN_MS / 1000} seconds — check for an infinite loop, or input it is still waiting for.`,
  SIGSEGV: 'Crashed: it touched memory it does not own — a bad pointer, or an index past the end of an array.',
  SIGBUS:  'Crashed on a bad memory access.',
  SIGTRAP: 'Crashed: a trap stopped it — often a failed assertion or an overflow check.',
  SIGABRT: 'Aborted: an assertion failed, or an exception was thrown and never caught.',
  SIGFPE:  'Crashed: divided by zero.',
  SIGXFSZ: 'Stopped: it tried to write a file larger than the limit.'
};

const withNote = (text, note) => !note ? (text || '') : ((text || '').trim() ? text.replace(/\n?$/, '\n') + note : note);

/* Linux reports a signal death as an exit code of 128 + the signal number,
   because bubblewrap sits between us and the program and exits that way. Left
   untranslated the explanations below never fired and a crash read as a bare
   "exit 139" with nothing in the output box — the same hole that used to
   swallow crashes on macOS, arriving by a different route. */
function signalOf(r) {
  if (r.signal) return r.signal;
  if (typeof r.code === 'number' && r.code > 128 && r.code < 160) {
    const n = r.code - 128;
    const names = osConstants.signals || {};
    return Object.keys(names).find(k => names[k] === n) || null;
  }
  return null;
}

function shape(r, started, warnings) {
  const ms = Date.now() - started;
  const sig = signalOf(r);
  const reason = sig ? SIGNAL_REASON[sig] : null;
  /* A CPU-limit kill is a timeout even though the wall-clock timer never fired:
     `ulimit -t` trips first whenever the program is genuinely busy, which is
     exactly what a runaway loop does. Calling that an ordinary "run" with a
     null exit code is how a hung program came to report "exit ?" and no
     output at all. */
  if (r.timedOut || sig === 'SIGXCPU' || sig === 'SIGKILL')
    return { ok: false, stage: 'timeout', stdout: r.stdout,
      stderr: withNote(r.stderr, reason || `Stopped after ${RUN_MS / 1000} seconds — check for an infinite loop or a missing input.`),
      signal: sig || null, ms, warnings };
  return { ok: r.code === 0, stage: 'run', stdout: r.stdout, stderr: withNote(r.stderr, reason),
    exitCode: r.code, signal: sig, ms, warnings };
}
